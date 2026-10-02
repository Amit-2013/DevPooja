"""Customer routes — port of server/routes/customer.js (profile, bookings,
payment verification, orders, tickets). The family-member routes from the same
Node file live in routers/kundali.py (they belong to the kundali module).
Route-for-route and response-shape parity with Node."""
import json
import random
import re
import time

from fastapi import APIRouter, Depends
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..models import (AuditLog, Booking, Coupon, Kit, Notif, Order, Prasad,
                      Setting, Ticket, User)
from ..security import require_role
from ..serialize import booking as s_booking, order as s_order, user as s_user
from ..services import bookings as B
from ..services import payments as pay
from ..util import (bad, conflict, http_error, j, not_found, rid, v_arr,
                     v_email, v_int, v_one_of, v_str)

router = APIRouter(prefix="/api", tags=["customer"])
customer_dep = require_role("customer")


def _me(db: AsyncSession, auth: dict) -> User:
    return db.get(User, auth["uid"])


def _location_shape(x) -> dict:
    """Profile location (additional-requirements Phase A): only the fields the
    app needs — city, country, optional coordinates captured with the user's
    permission, and how it was entered. Extra keys are ignored; junk
    coordinates/sources are rejected. An empty object clears the location."""
    l = x or {}

    def coord(n, lo, hi, label):
        if n in (None, ""):
            return None
        try:
            c = float(n)
        except (TypeError, ValueError):
            raise bad(label + " is invalid")
        if c < lo or c > hi:
            raise bad(label + " is invalid")
        return c

    out = {"city": v_str(l.get("city"), "City", optional=True, max_len=80),
           "country": v_str(l.get("country"), "Country", optional=True, max_len=80),
           "lat": coord(l.get("lat"), -90, 90, "Latitude"),
           "lon": coord(l.get("lon"), -180, 180, "Longitude"),
           "source": v_one_of(str(l.get("source")).lower(), ["auto", "manual"],
                              "Location source") if l.get("source") else ""}
    if not out["city"] and not out["country"] and out["lat"] is None and out["lon"] is None:
        return {}
    now = int(time.time() * 1000)
    ca = l.get("consentAt")
    out["consentAt"] = int(ca) if isinstance(ca, (int, float)) else now
    out["updatedAt"] = now
    return out


# --- available pandits (Phase 3: same centralized rules as the booking engine) ---
@router.get("/pandits/available")
async def available_pandits(date: str, slot: str, mode: str | None = None,
                            pujaId: str | None = None, city: str | None = None,
                            auth: dict = Depends(customer_dep),
                            db: AsyncSession = Depends(get_db)):
    from ..pricing import MODES, SLOTS
    from ..services.availability import who_is_available
    from ..util import v_date, v_one_of

    date_v = v_date(date)
    slot_v = v_one_of(slot, SLOTS, "Time slot")
    mode_v = mode if mode in MODES else "home"  # tolerant fallback, Node parity
    rows = await who_is_available(db, pujaId or "", city, date_v, slot_v, mode=mode_v)
    return {"pandits": [{"id": p.id, "n": p.name, "city": p.city, "rating": p.rating,
                          "pf": p.pf, "spec": j(p.spec, [])} for p in rows]}


# --- profile -----------------------------------------------------------------
@router.patch("/me")
async def update_me(body: dict, auth: dict = Depends(customer_dep),
                    db: AsyncSession = Depends(get_db)):
    u = await _me(db, auth)
    b = body or {}
    name = v_str(b.get("name"), "Name", max_len=80) if b.get("name") else u.name
    email = u.email
    if b.get("email") is not None and b.get("email") != "":
        email = v_email(b.get("email"))
        dup = (await db.execute(select(User).where(User.email == email, User.id != u.id)
                                .limit(1))).scalar_one_or_none()
        if dup:
            raise conflict("That email is already in use")
    p = b.get("pref") or {}
    pref = {"deity": v_str(p.get("deity"), "Deity", optional=True, max_len=40),
            "lang": v_str(p.get("lang") or "English", "Language", max_len=20),
            "wa": bool(p.get("wa")), "sms": bool(p.get("sms")), "em": bool(p.get("em"))}
    # Phase A additions: account-type switching (same account, never a second
    # account) and the optional profile location — both audited.
    prev_type = u.account_type or "normal"
    account_type = prev_type
    if b.get("accountType") not in (None, ""):
        account_type = v_one_of(str(b.get("accountType")).lower(), ["normal", "nri"],
                                "Account type")
    location = _location_shape(b.get("location")) if "location" in b else j(u.location, {})
    u.name, u.email, u.pref = name, email, json.dumps(pref)
    u.account_type, u.location = account_type, json.dumps(location)
    if account_type != prev_type:
        db.add(AuditLog(actor_user_id=u.id, actor_role=u.role,
                        action="user.account_type_switch", entity="user", entity_id=u.id,
                        detail=json.dumps({"from": prev_type, "to": account_type}),
                        old_value=json.dumps(prev_type), new_value=json.dumps(account_type),
                        reason=(str(b.get("reason"))[:200] if b.get("reason") else None),
                        created_at=int(time.time() * 1000)))
    if "location" in b:
        db.add(AuditLog(actor_user_id=u.id, actor_role=u.role,
                        action="user.location_update", entity="user", entity_id=u.id,
                        detail=json.dumps({"source": location.get("source", ""),
                                           "city": location.get("city", "")}),
                        created_at=int(time.time() * 1000)))
    await db.flush()
    return {"ok": True, "accountType": account_type, "location": location}


@router.post("/me/addresses")
async def add_address(body: dict, auth: dict = Depends(customer_dep),
                      db: AsyncSession = Depends(get_db)):
    u = await _me(db, auth)
    a = j(u.addr, [])
    if len(a) >= 10:
        raise bad("You can save up to 10 addresses")
    a.append({"id": "a" + rid(3),
              "l": v_str((body or {}).get("l") or "Address", "Label", max_len=30),
              "line": v_str((body or {}).get("line"), "Address", min_len=3, max_len=200),
              "city": v_str((body or {}).get("city"), "City", max_len=60),
              "pin": v_str((body or {}).get("pin"), "PIN", optional=True, max_len=6)})
    u.addr = json.dumps(a)
    await db.flush()
    return {"ok": True}


@router.delete("/me/addresses/{addr_id}")
async def del_address(addr_id: str, auth: dict = Depends(customer_dep),
                      db: AsyncSession = Depends(get_db)):
    u = await _me(db, auth)
    u.addr = json.dumps([x for x in j(u.addr, []) if x.get("id") != addr_id])
    await db.flush()
    return {"ok": True}


@router.post("/me/plus")
async def plus_toggle(body: dict, auth: dict = Depends(customer_dep),
                      db: AsyncSession = Depends(get_db)):
    if pay.mode() != "mock":
        raise http_error(501, "Plus checkout needs the payment gateway wired for subscriptions. See README.")
    u = await _me(db, auth)
    u.plus = 1 if (body or {}).get("on") else 0
    await db.flush()
    return {"ok": True}


# --- bookings ------------------------------------------------------------------
@router.post("/bookings", status_code=201)
async def create_booking(body: dict, auth: dict = Depends(customer_dep),
                         db: AsyncSession = Depends(get_db)):
    u = await _me(db, auth)
    row = await B.create_booking(db, u, body or {})
    payment = None
    if pay.mode() == "razorpay":
        try:
            payment = await pay.create_order(s_booking(row)["q"]["total"], row.id)
            p = j(row.pay, {})
            p["orderId"] = payment["orderId"]
            row.pay = json.dumps(p)
            await db.flush()
        except Exception:  # noqa: BLE001 — Node cancels the hold and surfaces 502
            await B._cancel_internal(db, row, 0, "Payment gateway error", send_notice=False)
            raise http_error(502, "Payment gateway error. Please try again.")
    return {"booking": s_booking(row), "payment": payment}


@router.post("/payments/verify")
async def payments_verify(body: dict, auth: dict = Depends(customer_dep),
                          db: AsyncSession = Depends(get_db)):
    u = await _me(db, auth)
    row = await B.confirm_payment(db, u, str((body or {}).get("bookingId") or ""), body or {})
    return {"booking": s_booking(row)}


# --- Phase 13: NRI packages — public catalogue + idempotent checkout.
# Deliberately NOT under /bookings: these are fixed-price currency packages
# (kundali-billing pattern), not pandit bookings — no slot, no payout engine.
from ..services import nri as NRI  # noqa: E402


@router.get("/nri-packages")
async def nri_packages(db: AsyncSession = Depends(get_db)):
    return {"packages": await NRI.list_active(db)}


# --- Additional-requirements Phase B: the Our People directory is public. Only
# active people in active categories leave the server; the profile carries the
# admin-managed story and gallery.
from ..services import people as PEOPLE  # noqa: E402


@router.get("/people")
async def people_directory(db: AsyncSession = Depends(get_db)):
    return {"categories": await PEOPLE.list_active_categories(db),
            "people": await PEOPLE.list_active(db)}


@router.get("/people/{person_id}")
async def people_profile(person_id: str, db: AsyncSession = Depends(get_db)):
    p = await PEOPLE.profile(db, person_id)
    if not p:
        raise not_found("Person not found")
    return {"person": p}


# --- Additional-requirements Phase D: the photo + video gallery is public.
# kind=photos|videos|albums picks the tab, album narrows it, limit/offset
# paginate it; only active rows in active albums leave the server.
from ..services import gallery as GALLERY  # noqa: E402


@router.get("/gallery")
async def gallery(kind: str = "photos", album: str = "", limit: int = 12,
                  offset: int = 0, db: AsyncSession = Depends(get_db)):
    return await GALLERY.public_gallery(db, kind=kind, album=album or None,
                                        limit=limit, offset=offset)


@router.get("/nri-orders")
async def my_nri_orders(auth: dict = Depends(customer_dep), db: AsyncSession = Depends(get_db)):
    return {"orders": await NRI.orders_for(db, auth["uid"])}


@router.post("/nri-orders", status_code=201)
async def checkout_nri(body: dict, auth: dict = Depends(customer_dep),
                       db: AsyncSession = Depends(get_db)):
    u = await _me(db, auth)
    order = await NRI.checkout(db, auth["uid"], u.id, body or {})
    # Gateway mode: attach a Razorpay order in the PACKAGE currency so the
    # client checkout opens with the real price the customer was quoted.
    payment = None
    if order["status"] == "PENDING_PAYMENT":
        from ..services import payments as pay
        from ..util import bad
        try:
            payment = await pay.create_order(order["amount"], order["id"])
        except Exception as e:  # pragma: no cover - message shape mirrors the Node twin
            raise bad("Payment gateway error: " + str(e))
        row = await NRI.get(db, order["packageId"])
        from ..models import NriOrder
        nri_row = (await db.execute(select(NriOrder).where(NriOrder.id == order["id"]))).scalar_one()
        nri_row.gateway_order_id = payment["orderId"]
        await db.commit()
        order = {**order, "gatewayOrderId": payment["orderId"]}
    return {"order": order, "payment": payment}


@router.post("/nri-orders/{order_id}/verify")
async def verify_nri(order_id: str, body: dict, auth: dict = Depends(customer_dep),
                     db: AsyncSession = Depends(get_db)):
    u = await _me(db, auth)
    return await NRI.verify(db, auth["uid"], u.id, order_id, body or {})


@router.post("/bookings/{booking_id}/cancel")
async def cancel_booking(booking_id: str, auth: dict = Depends(customer_dep),
                         db: AsyncSession = Depends(get_db)):
    u = await _me(db, auth)
    return {"booking": s_booking(await B.cancel_booking(db, u, booking_id))}


@router.post("/bookings/{booking_id}/reschedule")
async def reschedule_booking(booking_id: str, body: dict,
                             auth: dict = Depends(customer_dep),
                             db: AsyncSession = Depends(get_db)):
    u = await _me(db, auth)
    return {"booking": s_booking(await B.reschedule_booking(db, u, booking_id, body or {}))}


@router.post("/bookings/{booking_id}/review")
async def review_booking(booking_id: str, body: dict,
                         auth: dict = Depends(customer_dep),
                         db: AsyncSession = Depends(get_db)):
    u = await _me(db, auth)
    return {"booking": s_booking(await B.review_booking(db, u, booking_id, body or {}))}


# --- shop orders ------------------------------------------------------------------
@router.post("/orders/coupon")
async def check_order_coupon(body: dict, auth: dict = Depends(customer_dep),
                             db: AsyncSession = Depends(get_db)):
    # Phase 14: live coupon check for the cart modal — same wording the order
    # create will enforce, without reserving anything or touching stock.
    from ..models import Kit, Prasad
    from ..services import coupons as C
    b = body or {}
    code = v_str(b.get("code"), "Coupon code", max_len=20)
    sub = 0
    for it in (b.get("items") or [])[:30]:
        kit = await db.get(Kit, it.get("k") or "")
        pr = None if kit else await db.get(Prasad, it.get("k") or "")
        if kit or pr:
            sub += (kit or pr).price * v_int(it.get("q") or 1, "Quantity", min_val=1, max_val=20)
    coupon, problem = await C.check_for_order(db, code, (await _me(db, auth)).id, sub)
    if problem:
        return {"code": code, "problem": problem}
    return {"code": coupon["code"], "problem": "", "discount": C.discount_for_order(coupon, sub)}


@router.post("/orders", status_code=201)
async def create_order(body: dict, auth: dict = Depends(customer_dep),
                       db: AsyncSession = Depends(get_db)):
    u = await _me(db, auth)
    b = body or {}
    items = v_arr(b.get("items"), "Items", 30)
    if not items:
        raise bad("Your cart is empty")
    address = v_str(b.get("address"), "Delivery address", min_len=5, max_len=200)
    city = v_str(b.get("city"), "City", max_len=60)
    seq = await B.next_seq(db, "order_seq", 1003)
    id = "OR" + str(seq)
    sub = 0
    clean = []
    for it in items:
        q = v_int(it.get("q"), "Quantity", min_val=1, max_val=20)
        kit = await db.get(Kit, it.get("k") or "")
        pr = None if kit else await db.get(Prasad, it.get("k") or "")
        if not kit and not pr:
            raise bad("Unknown item")
        if kit:
            if not kit.active:
                raise bad(f"{kit.name} is currently unavailable")
            res = await db.execute(update(Kit).where(
                Kit.id == kit.id, Kit.stock >= q).values(stock=Kit.stock - q))
            if res.rowcount == 0:
                raise conflict(f"{kit.name} does not have enough stock")
            sub += (kit.price or 0) * q
        else:
            if not pr.active:
                raise bad(f"{pr.name} is currently unavailable")
            if pr.stock is not None:
                res = await db.execute(update(Prasad).where(
                    Prasad.id == pr.id, Prasad.stock >= q).values(stock=Prasad.stock - q))
                if res.rowcount == 0:
                    raise conflict(f"{pr.name} does not have enough stock")
            sub += (pr.price or 0) * q
        clean.append({"k": it.get("k"), "q": q})
    # Phase 14: the cart redeems ALL-scope coupons against the goods subtotal.
    # Validation wording is shared with bookings/kundalis; delivery is charged
    # on the post-coupon subtotal so a code can never create a negative cart.
    from ..services import coupons as C
    disc = 0
    coupon_code = ""
    if b.get("coupon"):
        coupon, problem = await C.check_for_order(db, b["coupon"], u.id, sub)
        if problem:
            raise bad(problem)
        disc = C.discount_for_order(coupon, sub)
        if disc > 0:
            coupon_code = coupon["code"]
    after = max(0, sub - disc)
    dele = 0 if (after >= 999 or u.plus) else 49
    db.add(Order(id=id, user_id=u.id, items=json.dumps(clean), total=after + dele,
                 date=time.strftime("%Y-%m-%d"), status="Placed", city=city, address=address,
                 coupon=coupon_code, discount=disc))
    await db.flush()
    if coupon_code:
        await db.execute(update(Coupon).where(Coupon.code == coupon_code).values(used=Coupon.used + 1))
        await C.record_redemption(db, coupon_code, u.id, "order", id, disc)
    db.add(Notif(user_id=u.id, channel="WhatsApp", message=f"Order {id} placed.",
                 ts=int(time.time() * 1000)))
    row = await db.get(Order, id)
    return {"order": s_order(row)}


@router.post("/tickets", status_code=201)
async def create_ticket(body: dict, auth: dict = Depends(customer_dep),
                        db: AsyncSession = Depends(get_db)):
    u = await _me(db, auth)
    b = body or {}
    bid = v_str(b.get("b"), "Booking", optional=True, max_len=20)
    if bid:
        own = (await db.execute(select(Booking).where(
            Booking.id == bid, Booking.user_id == u.id).limit(1))).scalar_one_or_none()
        if not own:
            raise not_found("Booking not found")
    seq = await B.next_seq(db, "ticket_seq", 4)
    id = "TK" + str(seq)
    db.add(Ticket(id=id, user_id=u.id, booking_id=bid or None,
                  text=v_str(b.get("t"), "Issue", max_len=600), status="Open", prio="Medium"))
    await db.flush()
    return {"ok": True, "id": id}
