"""Customer-conduct escalation (flaggedCustomers follow-up) — Python twin of
server/services/customerHold.js: a SOFT review flag on NEW bookings of flagged
customers. While a customer is flagged by the reopen digest (live incidents
reopened across DISTINCT bookings beyond REOPEN_LIMIT), bookings they create
are stamped with customer_hold=1 + customer_hold_reason. The fulfilment flow
is deliberately NOT blocked — the pandit can still accept/start (a flagged
CUSTOMER is a trust signal for the ops team, not a fulfilment blocker; the
coupon/discount-hold alternative was rejected for punishing through an
unrelated channel with no review flow). Admins clear the flag with the
explicit release endpoint; resolving every live incident auto-releases held
bookings at the next boot/digest view. Per-BOOKING only."""
import time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import AuditLog, Booking, Notif, User
from ..util import not_found
from .reopen_digest import REOPEN_LIMIT, flagged_customers


def reason_for(cid: str) -> str:
    return (f"Customer review flag: this customer is on the conduct watchlist "
            f"(reopened incidents across distinct bookings, threshold {REOPEN_LIMIT}). "
            f"Awaiting admin review — the booking itself proceeds normally.")


def _now_ms() -> int:
    return int(time.time() * 1000)


async def is_flagged(db: AsyncSession, cid: str) -> bool:
    return any(x["customerId"] == cid for x in await flagged_customers(db))


async def stamp_on_create(db: AsyncSession, booking_id: str, customer_id: str | None) -> bool:
    """Stamp a booking just created by a flagged customer. Ops hears about it at
    STAMP time through the standard in-app notifs store — the badge on the
    bookings row was the only signal before, so the hold went unnoticed until
    someone opened the tab."""
    if not customer_id or not await is_flagged(db, customer_id):
        return False
    b = await db.get(Booking, booking_id)
    if not b:
        return False
    b.customer_hold = 1
    b.customer_hold_reason = reason_for(customer_id)
    cu = await db.get(User, customer_id)
    admins = (await db.execute(select(User.id).where(User.role == "admin"))).scalars().all()
    who = cu.name if cu else customer_id
    for a in admins:
        db.add(Notif(user_id=a, channel="In-App",
                     message=(f"Customer hold applied: booking {booking_id} by {who} "
                              f"— new booking by a flagged customer, awaiting review."),
                     ts=_now_ms()))
    await db.flush()
    return True


async def release(db: AsyncSession, booking_id: str, actor: str) -> dict:
    """Explicit admin release (POST /admin/bookings/{id}/release-customer-hold)."""
    row = await db.get(Booking, booking_id)
    if not row:
        raise not_found("Booking not found")
    if not row.customer_hold:
        return {"booking": row, "released": False}
    row.customer_hold = 0
    row.customer_hold_reason = None
    db.add(AuditLog(actor_user_id=actor, actor_role="admin", action="booking.customer_hold_released",
                    entity="booking", entity_id=booking_id,
                    detail='{"from": 1, "to": 0, "reason": "admin release"}',
                    created_at=_now_ms()))
    await db.flush()
    return {"booking": row, "released": True}


async def held_for(db: AsyncSession, cid: str) -> list:
    """Per-customer drill-in: every currently held booking of ONE flagged
    customer, in the admin booking-row shape the FE already renders."""
    from ..serialize import booking as s_booking
    rows = (await db.execute(select(Booking).where(
        Booking.customer_hold == 1, Booking.user_id == cid)
        .order_by(Booking.created.desc()))).scalars().all()
    return [s_booking(r) for r in rows]


async def release_batch(db: AsyncSession, cid: str, actor: str) -> dict:
    """Batch release: clears EVERY held booking of one flagged customer at once.
    One explicit audited release per booking (the SAME audit as the single
    endpoint) so the audit trail stays uniform — never one opaque bulk row."""
    ids = [r.id for r in (await db.execute(select(Booking).where(
        Booking.customer_hold == 1, Booking.user_id == cid))).scalars().all()]
    released = 0
    for bid in ids:
        r = await release(db, bid, actor)
        if r["released"]:
            released += 1
    return {"released": released, "ids": ids}


async def sweep(db: AsyncSession) -> int:
    """Auto-release every held booking of customers whose flag has cleared.
    Called at boot and lazily from the digest view, like the pandit-hold sweep."""
    held = (await db.execute(select(Booking.user_id).where(
        Booking.customer_hold == 1, Booking.user_id.is_not(None)).distinct())).scalars().all()
    released = 0
    for cid in held:
        if not await is_flagged(db, cid):
            released += await release_all_for(db, cid, "flag-cleared")
    return released


async def release_all_for(db: AsyncSession, cid: str, why: str) -> int:
    rows = (await db.execute(select(Booking).where(
        Booking.customer_hold == 1, Booking.user_id == cid))).scalars().all()
    if not rows:
        return 0
    for r in rows:
        r.customer_hold = 0
        r.customer_hold_reason = None
        db.add(AuditLog(actor_user_id=None, actor_role="system", action="booking.customer_hold_auto_released",
                        entity="booking", entity_id=r.id,
                        detail=__import__("json").dumps({"customerId": cid, "why": why}),
                        created_at=_now_ms()))
    await db.flush()
    return len(rows)
