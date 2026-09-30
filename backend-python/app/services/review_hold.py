"""Review hold for bookings of flagged pandits — Python twin of
server/services/reviewHold.js (per-pandit flagging follow-up).

While a pandit is flagged by the reopen digest (live incidents reopened across
DISTINCT bookings beyond REOPEN_LIMIT), NEW bookings carrying their id are
stamped with review_hold=1 + hold_reason. The assigned pandit cannot accept or
start a held booking until an admin releases it or the flag clears — resolving
every live incident auto-releases all held bookings at the next boot/digest
view (sweep). The hold is per-BOOKING, never a pandit-level block."""
import json

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import AuditLog, Booking, Pandit
from ..util import conflict, not_found
from .reopen_digest import REOPEN_LIMIT, flagged_pandit_ids


def reason_for(pid: str) -> str:
    return (f"Review hold: pandit {pid} is flagged for repeated incident reopens "
            f"across distinct bookings (threshold {REOPEN_LIMIT}). Awaiting admin review.")


async def is_flagged(db: AsyncSession, pid: str) -> bool:
    return pid in await flagged_pandit_ids(db)


def _now_ms() -> int:
    import time
    return int(time.time() * 1000)


async def stamp_on_create(db: AsyncSession, booking_id: str, pandit_id: str | None) -> bool:
    """Stamp a booking just created/assigned to a flagged pandit."""
    if not pandit_id or not await is_flagged(db, pandit_id):
        return False
    b = await db.get(Booking, booking_id)
    if not b:
        return False
    b.review_hold = 1
    b.hold_reason = reason_for(pandit_id)
    return True


async def guard(db: AsyncSession, booking: Booking, action: str) -> None:
    """Pandit-side guard: accept/start refuse while the hold stands. Falls back
    to a release when the flag has already cleared (belt-and-braces)."""
    if not booking or not booking.review_hold:
        return
    if not await is_flagged(db, booking.pandit_id):
        await release_all_for(db, booking.pandit_id, "flag-cleared")
        return
    raise conflict(f"This booking is under review hold: {reason_for(booking.pandit_id)} "
                   f"You cannot {action} it yet — the admin team has been asked to review.")


async def release(db: AsyncSession, booking_id: str, actor: str) -> dict:
    """Explicit admin release (POST /admin/bookings/{id}/release-hold)."""
    import time

    row = await db.get(Booking, booking_id)
    if not row:
        raise not_found("Booking not found")
    if not row.review_hold:
        return {"booking": row, "released": False}
    row.review_hold = 0
    row.hold_reason = None
    db.add(AuditLog(actor_user_id=actor, actor_role="admin", action="booking.hold_released",
                    entity="booking", entity_id=booking_id,
                    detail=json.dumps({"from": 1, "to": 0, "reason": "admin release"}),
                    created_at=int(time.time() * 1000)))
    p = (await db.execute(select(Pandit).where(Pandit.id == row.pandit_id))).scalar_one_or_none()
    if p and p.user_id:
        from ..models import Notif

        db.add(Notif(user_id=p.user_id, channel="In-App",
                     message=f"Booking {booking_id} is released from review hold — you can accept it now.",
                     ts=_now_ms()))
    return {"booking": row, "released": True}


async def sweep(db: AsyncSession) -> int:
    """Auto-release every held booking of pandits whose flag has cleared."""
    held_pids = (await db.execute(
        select(Booking.pandit_id).where(Booking.review_hold == 1).distinct())).scalars().all()
    released = 0
    for pid in held_pids:
        if not await is_flagged(db, pid):
            released += await release_all_for(db, pid, "flag-cleared")
    return released


async def release_all_for(db: AsyncSession, pid: str, why: str) -> int:
    import time

    rows = (await db.execute(
        select(Booking).where(Booking.review_hold == 1, Booking.pandit_id == pid))).scalars().all()
    if not rows:
        return 0
    for r in rows:
        r.review_hold = 0
        r.hold_reason = None
        db.add(AuditLog(actor_user_id=None, actor_role="system", action="booking.hold_auto_released",
                        entity="booking", entity_id=r.id,
                        detail=json.dumps({"panditId": pid, "why": why}),
                        created_at=int(time.time() * 1000)))
    p = (await db.execute(select(Pandit).where(Pandit.id == pid))).scalar_one_or_none()
    if p and p.user_id:
        from ..models import Notif

        n = len(rows)
        db.add(Notif(user_id=p.user_id, channel="In-App",
                     message=f"{n} booking{'s' if n > 1 else ''} released from review hold — "
                             f"the repeat-reopen flag on your account has cleared.",
                     ts=int(time.time() * 1000)))
    return len(rows)
