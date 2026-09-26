"""Booking business rules — port of server/services/bookings.js. Every rule the
UI shows is enforced here; the browser is never trusted. The server always
recomputes the price from app/pricing.py (the shared/pricing.js twin).

Node-parity notes:
- unique partial index on (pandit_id, date, slot) for non-cancelled bookings
  prevents double-booking; the Python create translates IntegrityError into 409;
- money/points/stock mutations ride the request session and commit on success
  (Node used SQLite transactions; HTTPException keeps earlier writes only where
  business rules demand it, matching the get_db contract);
- the pandit-slot index is created in seed_catalog (CREATE UNIQUE INDEX ...)."""
import json
import random
import re
import time
from datetime import date as date_cls, timedelta

from sqlalchemy import func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import (Booking, Coupon, Kit, Pandit, Prasad, Payout,
                      Puja, Setting, Temple, User)
from ..pricing import MODES, SLOTS, coupon_problem, hours_until, quote, refund_pct
from ..util import (bad, conflict, j, not_found, v_arr, v_date, v_int,
                    v_mobile, v_one_of, v_str)
from . import payments as pay

STATUSES = ["New", "Confirmed", "Assigned", "Started", "Completed", "Cancelled"]
OPEN = ["New", "Confirmed", "Assigned"]
TEMPLES_OFFER = []  # filled by seed; queries below are live


def now_ms() -> int:
    return int(time.time() * 1000)


def today() -> str:
    return time.strftime("%Y-%m-%d")


def iso_offset(days: int) -> str:
    d = date_cls.today() + timedelta(days=days)
    return d.isoformat()


def _log_append(row: Booking, text_msg: str) -> str:
    l = j(row.log, [])
    l.append([text_msg, today()])
    return json.dumps(l, ensure_ascii=False)


async def get_booking(db: AsyncSession, id: str) -> Booking | None:
    return (await db.execute(select(Booking).where(Booking.id == id))).scalar_one_or_none()


async def get_setting(db: AsyncSession, key: str, default):
    row = (await db.execute(select(Setting).where(Setting.key == key))).scalar_one_or_none()
    return j(row.value, default) if row else default


async def next_seq(db: AsyncSession, name: str, start: int) -> int:
    """Port of db.js nextSeq(): reads the counter, increments, persists."""
    cur = await get_setting(db, name, start - 1)
    n = cur + 1
    await db.execute(text(
        "INSERT INTO settings(key, value) VALUES(:k, :v) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value").bindparams(
        k=name, v=json.dumps(n)))
    return n


async def is_free(db: AsyncSession, p: Pandit, date: str, slot: str, skip_id: str = "") -> bool:
    if not p or p.status != "verified" or not p.avail:
        return False
    if date in j(p.off, []):
        return False
    clash = (await db.execute(
        select(Booking.id).where(
            Booking.pandit_id == p.id, Booking.date == date, Booking.slot == slot,
            Booking.status != "Cancelled", Booking.id != skip_id).limit(1))).scalar_one_or_none()
    return clash is None


async def auto_pick(db: AsyncSession, puja_id: str, city: str | None, date: str, slot: str) -> Pandit | None:
    rows = (await db.execute(select(Pandit).where(Pandit.status == "verified"))).scalars().all()
    free = [p for p in rows if await is_free(db, p, date, slot)]
    spec_of = lambda p: j(p.spec, [])  # noqa: E731

    def score(p: Pandit):
        return (puja_id in spec_of(p), p.city == city, p.rating or 0)
    free.sort(key=score, reverse=True)
    return free[0] if free else None


async def price_request(db: AsyncSession, user: User | None, body: dict, *, strict_coupon: bool = True) -> dict:
    """Validate the pricing-relevant parts of a request; ALWAYS recomputes."""
    puja = (await db.execute(
        select(Puja).where(Puja.id == (body.get("pujaId") or ""), Puja.hidden == 0))).scalar_one_or_none()
    if not puja:
        raise not_found("Puja not found")
    mode = v_one_of(body.get("mode"), list(MODES.keys()), "Puja type")
    if mode == "temple":
        temples = (await db.execute(select(Temple.pujas))).scalars().all()
        if not any(puja.id in j(t, []) for t in temples):
            raise bad("Temple puja is not available for this puja")
    pandit = None
    if body.get("panditId"):
        pandit = (await db.execute(select(Pandit).where(
            Pandit.id == body["panditId"], Pandit.status == "verified"))).scalar_one_or_none()
        if not pandit:
            raise bad("Pandit not available")
    kit_ids = list(dict.fromkeys(v_arr(body.get("sam"), "Samagri")))
    pra_ids = list(dict.fromkeys(v_arr(body.get("pra"), "Prasad")))
    kits = []
    for k in kit_ids:
        row = await db.get(Kit, k)
        if not row:
            raise bad("Unknown samagri kit")
        if not row.active:
            raise bad(f"{row.name} is currently unavailable")
        kits.append(row)
    prasad = []
    for k in pra_ids:
        row = await db.get(Prasad, k)
        if not row:
            raise bad("Unknown prasad item")
        if not row.active:
            raise bad(f"{row.name} is currently unavailable")
        prasad.append(row)
    coupon = None
    coupon_error = ""
    if body.get("coupon"):
        c = (await db.execute(select(Coupon).where(
            Coupon.code == str(body["coupon"]).upper()))).scalar_one_or_none()
        coupon = ({"code": c.code, "type": c.type, "val": c.val, "max": c.max,
                   "min": c.min, "active": bool(c.active)} if c else None)
    base = {"puja": {"price": puja.price},
            "pandit": {"pf": pandit.pf} if pandit else None,
            "plus": bool(user and user.plus),
            "kits": [{"price": k.price or 0} for k in kits],
            "prasad": [{"price": k.price or 0} for k in prasad],
            "points": user.pts if user else 0,
            "usePoints": bool(body.get("usePoints")) and user is not None}
    if body.get("coupon"):
        svc = quote(mode, {**base, "coupon": None, "usePoints": False})["svc"]
        coupon_error = coupon_problem(coupon, svc)
        if coupon_error:
            if strict_coupon:
                raise bad(coupon_error)
            coupon = None
    q = quote(mode, {**base, "coupon": coupon})
    return {"puja": puja, "mode": mode, "pandit": pandit, "kits": kits, "prasad": prasad,
            "coupon": coupon, "q": q, "coupon_error": coupon_error}


async def expire_unpaid(db: AsyncSession) -> None:
    """Release unpaid Razorpay holds older than 15 minutes."""
    rows = (await db.execute(
        select(Booking).where(Booking.status == "PendingPayment",
                              Booking.created < now_ms() - 15 * 60_000))).scalars().all()
    for r in rows:
        await _cancel_internal(db, r, 0, "Payment not completed", send_notice=False)
    if rows:
        await db.flush()


async def create_booking(db: AsyncSession, user: User, body: dict) -> dict:
    await expire_unpaid(db)
    date = v_date(body.get("date"))
    if date < iso_offset(1):
        raise bad("Choose a date from tomorrow onwards")
    slot = v_one_of(body.get("slot"), SLOTS, "Time slot")
    pr = await price_request(db, user, body)
    puja, mode, kits, prasad, q = pr["puja"], pr["mode"], pr["kits"], pr["prasad"], pr["q"]
    addr, temple_id = None, None
    if mode == "temple":
        t = await db.get(Temple, body.get("templeId") or "")
        if not t or puja.id not in j(t.pujas, []):
            raise bad("Choose a temple that offers this puja")
        temple_id = t.id
    else:
        a = body.get("addr") or {}
        addr = {"line": v_str(a.get("line") or ("Online (video call)" if mode == "online" else ""),
                              "Address", min_len=3, max_len=200),
                "city": v_str(a.get("city"), "City", max_len=60),
                "pin": v_str(a.get("pin"), "PIN", optional=True, max_len=6)}
    if body.get("usePoints") and q["pts"] > (user.pts or 0):
        raise bad("Not enough reward points")
    member = v_str(body.get("member") or "Self", "Member", max_len=80)
    notes = v_str(body.get("notes"), "Notes", optional=True, max_len=500)
    gateway = pay.mode() == "razorpay"

    pandit = pr["pandit"]
    if pandit:
        if not await is_free(db, pandit, date, slot):
            raise conflict("That pandit is no longer free at this time. Choose another pandit or slot.")
    else:
        pandit = await auto_pick(db, puja.id, addr and addr["city"], date, slot)
    for k in kits:
        res = await db.execute(
            update(Kit).where(Kit.id == k.id, Kit.stock > 0)
            .values(stock=Kit.stock - 1))
        if res.rowcount == 0:
            raise conflict(f"{k.name} is out of stock")
    if q["pts"]:
        await db.execute(update(User).where(User.id == user.id)
                         .values(pts=User.pts - q["pts"]))
    if pr["coupon"] and q["disc"]:
        await db.execute(update(Coupon).where(Coupon.code == pr["coupon"]["code"])
                         .values(used=Coupon.used + 1))
    seq = await next_seq(db, "booking_seq", 2401)
    id = "DP" + str(seq)
    status = "PendingPayment" if gateway else ("Confirmed" if pandit else "New")
    pay_info = {"method": "razorpay" if gateway else str(body.get("payMethod") or "UPI")[:20],
                "ref": "" if gateway else "MOCK" + str(random.randint(100000, 999999)),
                "paid": not gateway}
    row = Booking(id=id, user_id=user.id, puja_id=puja.id, mode=mode, date=date, slot=slot,
                  addr=json.dumps(addr, ensure_ascii=False) if addr else None,
                  temple_id=temple_id, pandit_id=pandit.id if pandit else None,
                  pst="pending" if pandit else None,
                  sam=json.dumps([k.id for k in kits]), pra=json.dumps([k.id for k in prasad]),
                  notes=notes, member=member, coupon=pr["coupon"]["code"] if pr["coupon"] else "",
                  q=json.dumps(q), status=status, pay=json.dumps(pay_info),
                  ops=json.dumps({"sam": "Packed" if kits else "", "pra": ""}), media="[]",
                  created=now_ms(),
                  log=json.dumps([["Awaiting payment" if gateway else "Booking confirmed", today()]]))
    db.add(row)
    try:
        await db.flush()
    except IntegrityError:
        raise conflict("That pandit was just booked for this slot. Choose another.")
    if not gateway:
        await _announce(db, row, user)
    return row


async def _announce(db: AsyncSession, row: Booking, user: User | None) -> None:
    """Node announces via notify(); here we persist notifs rows (same channels)."""
    from ..models import Notif
    puja = await db.get(Puja, row.puja_id)
    name = puja.name if puja else row.puja_id
    msg = f"Booking {row.id} confirmed: {name} on {row.date}, {row.slot}."
    for ch in ("WhatsApp", "SMS", "Email"):
        db.add(Notif(user_id=row.user_id, channel=ch, message=msg, ts=now_ms()))


async def confirm_payment(db: AsyncSession, user: User, id: str, body: dict) -> Booking:
    row = await get_booking(db, id)
    if not row or row.user_id != user.id:
        raise not_found("Booking not found")
    p = j(row.pay, {})
    if p.get("paid"):
        return row
    if row.status != "PendingPayment":
        raise bad("This booking is no longer awaiting payment")
    if (p.get("orderId") != body.get("razorpay_order_id")
            or not pay.verify_signature(body.get("razorpay_order_id"),
                                        body.get("razorpay_payment_id"),
                                        body.get("razorpay_signature"))):
        raise bad("Payment verification failed")
    row.status = "Confirmed" if row.pandit_id else "New"
    row.pay = json.dumps({**p, "paid": True, "ref": body.get("razorpay_payment_id")})
    row.log = _log_append(row, "Payment received")
    await db.flush()
    await _announce(db, row, user)
    return row


async def _release_resources(db: AsyncSession, row: Booking) -> None:
    q = j(row.q, {})
    ops = j(row.ops, {})
    if q.get("pts"):
        await db.execute(update(User).where(User.id == row.user_id).values(pts=User.pts + q["pts"]))
    if ops.get("sam") != "Delivered":
        for k in j(row.sam, []):
            await db.execute(update(Kit).where(Kit.id == k).values(stock=Kit.stock + 1))


async def _cancel_internal(db: AsyncSession, row: Booking, pct: int, reason: str,
                           send_notice: bool = True) -> Booking:
    q = j(row.q, {})
    paid = j(row.pay, {}).get("paid")
    refund = ({"amt": round(q.get("total", 0) * pct / 100), "pct": pct, "state": "Initiated"}
              if paid and pct > 0 else None)
    row.status = "Cancelled"
    row.refund = json.dumps(refund) if refund else None
    row.log = _log_append(row, reason)
    await _release_resources(db, row)
    await db.flush()
    if send_notice:
        from ..models import Notif
        msg = f"Booking {row.id} cancelled." + (f" Refund of Rs {refund['amt']} initiated." if refund else "")
        db.add(Notif(user_id=row.user_id, channel="Email", message=msg, ts=now_ms()))
    return row


async def cancel_booking(db: AsyncSession, user: User, id: str) -> Booking:
    row = await get_booking(db, id)
    if not row or row.user_id != user.id:
        raise not_found("Booking not found")
    if row.status not in OPEN + ["PendingPayment"]:
        raise bad("This booking can no longer be cancelled")
    pct = refund_pct(hours_until(row.date, row.slot))
    return await _cancel_internal(db, row, pct, "Cancelled by customer")


async def reschedule_booking(db: AsyncSession, user: User, id: str, body: dict) -> Booking:
    row = await get_booking(db, id)
    if not row or row.user_id != user.id:
        raise not_found("Booking not found")
    if row.status not in OPEN:
        raise bad("This booking can no longer be rescheduled")
    date = v_date(body.get("date"))
    if date < iso_offset(1):
        raise bad("Choose a date from tomorrow onwards")
    slot = v_one_of(body.get("slot"), SLOTS, "Time slot")
    if row.pandit_id:
        p = await db.get(Pandit, row.pandit_id)
        if not await is_free(db, p, date, slot, skip_id=row.id):
            raise conflict("Your pandit is not free then. Try another slot.")
    row.date, row.slot = date, slot
    row.log = _log_append(row, "Rescheduled")
    await db.flush()
    from ..models import Notif
    db.add(Notif(user_id=user.id, channel="SMS",
                 message=f"Booking {id} rescheduled to {date}, {slot}.", ts=now_ms()))
    return row


async def review_booking(db: AsyncSession, user: User, id: str, body: dict) -> Booking:
    row = await get_booking(db, id)
    if not row or row.user_id != user.id:
        raise not_found("Booking not found")
    if row.status != "Completed":
        raise bad("You can review a puja after it is completed")
    if row.review:
        raise conflict("You have already reviewed this booking")
    r = v_int(body.get("r"), "Rating", min_val=1, max_val=5)
    t = v_str(body.get("t"), "Review", optional=True, max_len=500) or "Good experience."
    row.review = json.dumps({"r": r, "t": t, "by": user.name, "on": today()})
    await db.execute(update(User).where(User.id == user.id).values(pts=User.pts + 10))
    if row.pandit_id:
        p = await db.get(Pandit, row.pandit_id)
        if p:
            p.rating = round(((p.rating * p.rev + r) / (p.rev + 1)) * 10) / 10
            p.rev = (p.rev or 0) + 1
    await db.flush()
    return row


async def complete_booking(db: AsyncSession, row: Booking, media_urls: list | None = None) -> Booking:
    q = j(row.q, {})
    ops = j(row.ops, {})
    if j(row.sam, []):
        ops["sam"] = "Delivered"
    if j(row.pra, []) or row.mode == "temple":
        ops["pra"] = ops.get("pra") or "Dispatched"
    media = [*j(row.media, []), *(media_urls or [])]
    row.status = "Completed"
    row.pst = "accepted"
    row.ops = json.dumps(ops)
    row.media = json.dumps(media)
    row.log = _log_append(row, "Completed")
    await db.execute(update(User).where(User.id == row.user_id).values(pts=User.pts + (q.get("earn") or 0)))
    if row.pandit_id:
        await db.execute(update(Pandit).where(Pandit.id == row.pandit_id).values(done=Pandit.done + 1))
        # Centralized payout engine (Phases 7-8): commission math, hold evaluation
        # and status vocabulary live in services/payout_engine.py — never inline here.
        from .payout_engine import create_for_booking
        await create_for_booking(db, row, row.pandit_id)
    await db.flush()
    from ..models import Notif
    puja = await db.get(Puja, row.puja_id)
    name = puja.name if puja else row.puja_id
    db.add(Notif(user_id=row.user_id, channel="WhatsApp",
                 message=(f"Your {name} ({row.id}) is complete. Photos and certificate are ready. "
                          f"You earned {q.get('earn') or 0} points."), ts=now_ms()))
    return row


async def pandit_act(db: AsyncSession, pid: str, id: str, action: str,
                     media: list | None = None) -> Booking:
    row = await get_booking(db, id)
    if not row or row.pandit_id != pid:
        raise not_found("Booking not found")
    if action == "accept":
        if row.pst != "pending" or row.status not in OPEN:
            raise bad("Nothing to accept")
        row.pst = "accepted"
        row.status = "Assigned"
        row.log = _log_append(row, "Pandit accepted")
        from ..models import Notif
        db.add(Notif(user_id=row.user_id, channel="WhatsApp",
                     message=f"A pandit has accepted your booking {id}.", ts=now_ms()))
    elif action == "reject":
        if row.pst != "pending":
            raise bad("Only pending requests can be rejected")
        row.pandit_id = None
        row.pst = None
        row.status = "New"
        row.log = _log_append(row, "Pandit declined, reassigning")
    elif action == "start":
        if row.status != "Assigned":
            raise bad("Accept the booking before starting")
        row.status = "Started"
        row.log = _log_append(row, "Puja started")
        from ..models import Notif
        db.add(Notif(user_id=row.user_id, channel="WhatsApp",
                     message=f"Your puja {id} has started.", ts=now_ms()))
    elif action == "complete":
        if row.status != "Started":
            raise bad("Start the puja before completing it")
        await complete_booking(db, row, media)
    else:
        raise bad("Unknown action")
    await db.flush()
    return row


async def admin_assign(db: AsyncSession, id: str, pid: str | None) -> Booking:
    row = await get_booking(db, id)
    if not row:
        raise not_found("Booking not found")
    if row.status in ("Completed", "Cancelled"):
        raise bad("This booking is closed")
    if not pid:
        row.pandit_id = None
        row.pst = None
        if row.status == "Assigned":
            row.status = "Confirmed"
        row.log = _log_append(row, "Unassigned")
    else:
        p = await db.get(Pandit, pid)
        if not p or not await is_free(db, p, row.date, row.slot, skip_id=row.id):
            raise conflict("That pandit is not free at this time.")
        row.pandit_id = pid
        row.pst = "pending"
        if row.status == "New":
            row.status = "Confirmed"
        row.log = _log_append(row, "Assigned to " + (p.name or ""))
        from ..models import Notif
        db.add(Notif(user_id=row.user_id, channel="WhatsApp",
                     message=f"A pandit has been assigned to {id}: {p.name}.", ts=now_ms()))
    await db.flush()
    return row


async def admin_status(db: AsyncSession, id: str, status: str) -> Booking:
    row = await get_booking(db, id)
    if not row:
        raise not_found("Booking not found")
    v_one_of(status, STATUSES, "Status")
    if row.status == status:
        return row
    if status == "Completed":
        if row.status == "Cancelled":
            raise bad("Cancelled bookings cannot be completed")
        return await complete_booking(db, row)
    if status == "Cancelled":
        return await _cancel_internal(db, row, 100, "Cancelled by admin")
    if row.status in ("Completed", "Cancelled"):
        raise bad("Closed bookings cannot be reopened")
    row.status = status
    row.log = _log_append(row, status)
    await db.flush()
    from ..models import Notif
    db.add(Notif(user_id=row.user_id, channel="WhatsApp",
                 message=f"Booking {id} is now {status}.", ts=now_ms()))
    return row


async def admin_manual(db: AsyncSession, body: dict) -> Booking:
    name = v_str(body.get("name"), "Name", max_len=80)
    mobile = v_mobile(body.get("mobile"))
    u = (await db.execute(select(User).where(User.mobile == mobile))).scalar_one_or_none()
    if not u:
        uid = "u" + str(now_ms())
        u = User(id=uid, role="customer", name=name, mobile=mobile, pts=0, plus=0,
                 pref="{}", addr="[]", fam="[]", joined=today(), created_at=now_ms())
        db.add(u)
        await db.flush()
    mode = v_one_of(body.get("mode"), list(MODES.keys()), "Type")
    slot = v_one_of(body.get("slot"), SLOTS, "Slot")
    date = v_date(body.get("date"))
    pr = await price_request(db, u, {"pujaId": body.get("pujaId"), "mode": mode, "sam": [], "pra": []})
    seq = await next_seq(db, "booking_seq", 2401)
    id = "DP" + str(seq)
    temple_id = None
    if mode == "temple":
        temples = (await db.execute(select(Temple).where(Temple.id.isnot(None)))).scalars().all()
        t = next((t for t in temples if pr["puja"].id in j(t.pujas, [])), None)
        temple_id = t.id if t else None
    row = Booking(id=id, user_id=u.id, puja_id=pr["puja"].id, mode=mode, date=date, slot=slot,
                  addr=None if mode == "temple" else json.dumps({
                      "line": "Address to be confirmed",
                      "city": str(body.get("city") or "Delhi NCR"), "pin": ""}),
                  temple_id=temple_id, pandit_id=None, pst=None, sam="[]", pra="[]",
                  notes="Manual booking by admin", member="Self", coupon="",
                  q=json.dumps(pr["q"]), status="New",
                  pay=json.dumps({"method": "Offline",
                                  "ref": "MAN" + str(now_ms())[-6:], "paid": False}),
                  ops="{}", media="[]", created=now_ms(),
                  log=json.dumps([["Manual booking created", today()]]))
    db.add(row)
    await db.flush()
    return row
