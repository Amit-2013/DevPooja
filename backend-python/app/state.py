"""Role-scoped state builder — port of server/lib/state.js. Customers only ever
receive their own data; pandits see masked mobiles; admins see everything."""
import os

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .services import payments as pay
from .models import (Banner, Booking, Coupon, Festival, Kit, Notif, Order,
                     Pandit, Prasad, Payout, Puja, Temple, Ticket, User)
from .serialize import (booking, coupon, festival, kit, notif, order, pandit,
                        prasad, puja, temple, ticket, payout as s_payout, user)
from .services.bookings import expire_unpaid, get_setting
from .util import j


def _mask(m: str | None) -> str:
    return (m[:2] + "XXXXXX" + m[-2:]) if m else ""


async def build_state(db: AsyncSession, auth: dict | None) -> dict:
    await expire_unpaid(db)
    role = auth and auth.get("role")
    kits = (await db.execute(select(Kit))).scalars().all()
    puja_rows = (await db.execute(
        select(Puja) if role == "admin" else select(Puja).where(Puja.hidden == 0))).scalars().all()
    kit_items = {k.id: j(k.items, []) for k in kits}
    demo = (os.environ.get("DEMO_MODE") or "true").lower() == "true"

    st = {
        "session": ({"role": role, "uid": auth.get("uid"), "pid": auth.get("pid") or None}
                    if auth else None),
        "config": {"paymentMode": pay.mode(),
                   "razorpayKeyId": os.environ.get("RAZORPAY_KEY_ID") if pay.mode() == "razorpay" else None,
                   "demo": demo},
        "catalog": {
            "pujas": [puja(r, kit_items.get(r.kit)) for r in puja_rows],
            "kits": [kit(k) for k in kits],
            "prasad": [prasad(k) for k in (await db.execute(select(Prasad))).scalars().all()],
            "temples": [temple(t) for t in (await db.execute(select(Temple))).scalars().all()],
            "festivals": [festival(f) for f in (await db.execute(
                select(Festival).order_by(Festival.date))).scalars().all()],
        },
        "banners": [{"id": b.id, "t": b.text, "on": True} for b in
                    (await db.execute(select(Banner).where(Banner.enabled == 1))).scalars().all()],
        "kundali": {"enabled": True, "purposes": ["General", "Marriage", "Career", "Business",
                                                  "Health & Wellness", "Finance", "Education",
                                                  "Family", "Child", "Spiritual", "Property", "Other"]},
        "toggles": {"home": True, "online": True, "temple": True, "customized": True,
                    "kundali": True, "pandit": True, "templeDir": True, "prasad": True,
                    "samagri": True, "astrology": True},
        "pandits": [], "busy": [], "reviews": [],
        "me": None, "users": [], "bookings": [], "orders": [], "notifs": [], "tickets": [],
        "coupons": [], "payouts": [], "inv": {}, "campaigns": [], "leads": [], "set": {}, "hidden": [],
    }
    _ = get_setting  # imported for parity; settings surfaced per-role below

    p_rows = (await db.execute(select(Pandit))).scalars().all()
    st["pandits"] = [pandit(p, admin=(role == "admin")) for p in p_rows
                     if role == "admin" or p.status == "verified"
                     or (role == "pandit" and p.id == auth.get("pid"))]
    busy_rows = (await db.execute(select(Booking.id, Booking.pandit_id, Booking.date, Booking.slot).where(
        Booking.pandit_id.isnot(None), Booking.status != "Cancelled"))).all()
    st["busy"] = [{"id": r.id, "p": r.pandit_id, "date": r.date, "slot": r.slot} for r in busy_rows]
    st["reviews"] = [{"pid": r.pandit_id, "r": j(r.review, {}).get("r"),
                      "t": j(r.review, {}).get("t"), "by": j(r.review, {}).get("by"),
                      "puja": r.puja_id} for r in (await db.execute(
        select(Booking).where(Booking.review.isnot(None), Booking.review_hidden == 0,
                              Booking.pandit_id.isnot(None)))).scalars().all()]

    if role == "customer":
        u = await db.get(User, auth["uid"])
        st["me"] = user(u)
        st["users"] = [st["me"]]
        st["bookings"] = [booking(b) for b in (await db.execute(
            select(Booking).where(Booking.user_id == u.id, Booking.status != "PendingPayment")
            .order_by(Booking.created.desc()))).scalars().all()]
        st["orders"] = [order(o) for o in (await db.execute(
            select(Order).where(Order.user_id == u.id).order_by(Order.date.desc()))).scalars().all()]
        st["notifs"] = [notif(n) for n in (await db.execute(
            select(Notif).where(Notif.user_id == u.id).order_by(Notif.ts.desc())
            .limit(100))).scalars().all()]
        st["tickets"] = [ticket(t) for t in (await db.execute(
            select(Ticket).where(Ticket.user_id == u.id).order_by(Ticket.id.desc()))).scalars().all()]
    elif role == "pandit":
        st["bookings"] = [booking(b) for b in (await db.execute(
            select(Booking).where(Booking.pandit_id == auth["pid"],
                                  Booking.status != "PendingPayment")
            .order_by(Booking.date))).scalars().all()]
        ids = list(dict.fromkeys(b["userId"] for b in st["bookings"]))
        st["users"] = [{"id": uid, "n": (u2.name if (u2 := await db.get(User, uid)) else ""),
                        "m": _mask(u2.mobile if u2 else ""), "e": "", "pts": 0, "plus": False,
                        "addr": [], "fam": [], "pref": {}, "joined": ""} for uid in ids]
        st["payouts"] = [s_payout(p) for p in (await db.execute(
            select(Payout).where(Payout.pandit_id == auth["pid"]))).scalars().all()]
        st["set"] = {"comm": await get_setting(db, "commission", 20)}
    elif role == "admin":
        st["bookings"] = [booking(b) for b in (await db.execute(
            select(Booking).where(Booking.status != "PendingPayment")
            .order_by(Booking.created.desc()))).scalars().all()]
        st["users"] = [user(r) for r in (await db.execute(
            select(User).where(User.role == "customer"))).scalars().all()]
        st["orders"] = [order(o) for o in (await db.execute(
            select(Order).order_by(Order.date.desc()))).scalars().all()]
        st["tickets"] = [ticket(t) for t in (await db.execute(
            select(Ticket).order_by(Ticket.id.desc()))).scalars().all()]
        st["coupons"] = [coupon(c) for c in (await db.execute(select(Coupon))).scalars().all()]
        st["payouts"] = [s_payout(p) for p in (await db.execute(select(Payout))).scalars().all()]
        st["inv"] = {k.id: k.stock for k in kits}
        st["campaigns"] = []
        st["leads"] = []
        st["set"] = {"comm": await get_setting(db, "commission", 20)}
        st["hidden"] = [r.id for r in (await db.execute(
            select(Booking).where(Booking.review_hidden == 1))).scalars().all()]
        st["banners"] = [{"id": b.id, "t": b.text, "on": bool(b.enabled)} for b in
                         (await db.execute(select(Banner))).scalars().all()]
    return st
