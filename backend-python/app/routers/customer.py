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
from ..models import (Booking, Coupon, Kit, Notif, Order, Prasad, Setting,
                      Ticket, User)
from ..security import require_role
from ..serialize import booking as s_booking, order as s_order, user as s_user
from ..services import bookings as B
from ..services import payments as pay
from ..util import bad, conflict, http_error, j, not_found, rid, v_arr, v_email, v_int, v_str

router = APIRouter(prefix="/api", tags=["customer"])
customer_dep = require_role("customer")


def _me(db: AsyncSession, auth: dict) -> User:
    return db.get(User, auth["uid"])


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
    u.name, u.email, u.pref = name, email, json.dumps(pref)
    await db.flush()
    return {"ok": True}


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
    dele = 0 if (sub >= 999 or u.plus) else 49
    db.add(Order(id=id, user_id=u.id, items=json.dumps(clean), total=sub + dele,
                 date=time.strftime("%Y-%m-%d"), status="Placed", city=city, address=address))
    await db.flush()
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
