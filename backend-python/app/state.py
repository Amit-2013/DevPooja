"""Role-scoped state builder — port of server/lib/state.js. Customers only ever
receive their own data; pandits see masked mobiles; admins see everything."""
import os

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .services import payments as pay
from .models import (Banner, Booking, Campaign, Coupon, Festival, Kit, Kundali, Lead, Notif, Order,
                     Pandit, Prasad, Payout, Puja, Temple, Ticket, User)
from .serialize import (booking, coupon, festival, kit, lead as s_lead, notif, order, pandit,
                        prasad, puja, temple, ticket, payout as s_payout, user)
from .services import people as PEOPLE
from .services import socials as SOCIALS
from .services import gallery as GALLERY
from .services.bookings import expire_unpaid, get_setting
from .services.reopen_digest import flagged_pandit_ids
from .util import j
from .permissions import is_family


def _mask(m: str | None) -> str:
    return (m[:2] + "XXXXXX" + m[-2:]) if m else ""


TOGGLE_DEFAULTS = {"services": True, "home": True, "online": True, "temple": True,
                   "customized": True, "kundali": True, "pandit": True,
                   "templeDir": True, "prasad": True, "samagri": True,
                   "astrology": True}


async def _service_toggles(db: AsyncSession) -> dict:
    """Service-visibility settings (Node parity: server/lib/state.js) — stored
    JSON merged over the defaults; `services` is the master ON/OFF switch."""
    cur = dict(TOGGLE_DEFAULTS)
    stored = await get_setting(db, "service_toggles", None)
    if isinstance(stored, dict):
        cur.update(stored)
    return cur


async def build_state(db: AsyncSession, auth: dict | None) -> dict:
    await expire_unpaid(db)
    role = auth and auth.get("role")
    is_admin = is_family(role)
    kits = (await db.execute(select(Kit))).scalars().all()
    puja_rows = (await db.execute(
        select(Puja) if is_admin else select(Puja).where(Puja.hidden == 0))).scalars().all()
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
            "temples": [temple(t) for t in (await db.execute(select(Temple).where(Temple.active == 1))).scalars().all()],
            "festivals": [festival(f) for f in (await db.execute(
                select(Festival).order_by(Festival.date))).scalars().all()],
        },
        "banners": [{"id": b.id, "t": b.text, "on": True} for b in
                    (await db.execute(select(Banner).where(Banner.enabled == 1))).scalars().all()],
        "kundali": {"enabled": True, "purposes": ["General", "Marriage", "Career", "Business",
                                                  "Health & Wellness", "Finance", "Education",
                                                  "Family", "Child", "Spiritual", "Property", "Other"]},
        "toggles": await _service_toggles(db),
        "pandits": [], "busy": [], "reviews": [],
        "me": None, "users": [], "bookings": [], "orders": [], "notifs": [], "tickets": [],
        "coupons": [], "payouts": [], "inv": {}, "campaigns": [], "leads": [], "set": {}, "hidden": [],
        # Additional-requirements Phase B: compact public Our People data for the
        # directory/footer; admins additionally get the full rows (inactive too).
        "peopleCats": [], "peopleList": [], "peopleAdmin": [], "peopleCatsAdmin": [],
        # Additional-requirements Phase C: active social rows for the footer
        # (every role), plus the full list for the admin Social links tab.
        "socials": [], "socialsAdmin": [],
        # Additional-requirements Phase D: the public gallery overview (active
        # albums + a first page of photos/videos) for every role, plus the
        # full rows for the admin gallery tabs.
        "gallery": {"albums": [], "photos": [], "videos": [], "totalPhotos": 0, "totalVideos": 0},
        "galleryAdmin": {"albums": [], "photos": [], "videos": []},
    }
    _ = get_setting  # imported for parity; settings surfaced per-role below
    st["peopleCats"] = await PEOPLE.list_active_categories(db)
    st["peopleList"] = await PEOPLE.list_active(db)
    st["socials"] = await SOCIALS.list_active(db)
    st["gallery"] = await GALLERY.overview(db)

    p_rows = (await db.execute(select(Pandit))).scalars().all()
    # Per-pandit flagging follow-up: admins see which pandits are currently
    # flagged by the repeat-reopen digest (drives the pandit-module surfacing).
    flagged_ids = (await flagged_pandit_ids(db)) if is_admin else []
    st["pandits"] = [pandit(p, admin=is_admin,
                            self=(role == "pandit" and p.id == auth.get("pid")),
                            flagged=(p.id in flagged_ids))
                     for p in p_rows
                     if is_admin or p.status == "verified"
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
        st["tickets"] = [ticket(t) for t in (await db.execute(
            select(Ticket).where(Ticket.user_id == u.id).order_by(Ticket.id.desc()))).scalars().all()]
        st["myKundalis"] = [{
            "kundaliId": k.id, "name": k.name, "relationship": k.relationship or "Self",
            "billing": k.billing, "price": k.price, "gst": k.gst, "final": k.final_amount,
            "paymentStatus": k.payment_status, "orderId": k.order_id,
            "createdAt": k.created_at,
        } for k in (await db.execute(
            select(Kundali).where(Kundali.customer_id == u.id)
            .order_by(Kundali.created_at.desc()))).scalars().all()]
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
    elif is_admin:
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
        # Phases 27-29: full campaign lifecycle rows for the marketing tab.
        from .services.comms import out as s_campaign
        st["campaigns"] = [s_campaign(c) for c in (await db.execute(
            select(Campaign).order_by(Campaign.created_at.desc().nullslast(), Campaign.id.desc())
        )).scalars().all()]
        # Phase 26: full CRM rows (pipeline, contact, assignment) for the support tab.
        st["leads"] = [s_lead(l) for l in (await db.execute(
            select(Lead).order_by(Lead.id.desc()).limit(500))).scalars().all()]
        st["set"] = {"comm": await get_setting(db, "commission", 20),
                     # Phase 16: the cancellation policy rides along for the finance tab.
                     "cxp": await get_setting(db, "cancellation_policy", None)}
        st["hidden"] = [r.id for r in (await db.execute(
            select(Booking).where(Booking.review_hidden == 1))).scalars().all()]
        st["banners"] = [{"id": b.id, "t": b.text, "on": bool(b.enabled)} for b in
                         (await db.execute(select(Banner))).scalars().all()]
        st["peopleAdmin"] = await PEOPLE.list_all(db)
        st["peopleCatsAdmin"] = await PEOPLE.list_categories(db)
        st["socialsAdmin"] = await SOCIALS.list_all(db)
        st["galleryAdmin"] = await GALLERY.admin_bundle(db)
    # Admin notifications centre (item): own notifs + unread count for EVERY
    # signed-in role — the bell badge lives in the main header, so admins and
    # pandits get their ops alerts here too (Node parity: lib/state.js).
    if auth:
        rows = (await db.execute(select(Notif).where(Notif.user_id == auth["uid"])
                                 .order_by(Notif.ts.desc()).limit(100))).scalars().all()
        st["notifs"] = [notif(n) for n in rows]
        st["notifsUnread"] = (await db.execute(
            select(func.count()).select_from(Notif)
            .where(Notif.user_id == auth["uid"], Notif.read_at.is_(None)))).scalar() or 0
    return st
