"""Phase 20 follow-up: repeat-reopen digest — the Operations-tab review queue.

An incident dismissed-and-reopened more than REOPEN_LIMIT times (default 2) is
a systemic signal: recurring conduct/safety issues, disputed dismissals, or a
pandit stuck in a loop one-off triage keeps losing. Reopened incidents are
live queue items (they return to UNDER_REVIEW), so the digest lists exactly
those, newest reopen first. Mirrors server/services/incidents.js reopenDigest.

Per-pandit flagging: a pandit whose reopen-count exceeds the threshold across
DISTINCT bookings (reopens on the same booking collapse to one) is a repeated-
pattern signal that outlives any single incident — surfaced as flagged_pandits
so operations can review the pandit, not just the incident.
"""
from sqlalchemy import func, select, text

REOPEN_LIMIT = 2


async def reopen_digest(db, limit: int | None = None) -> dict:
    from ..models import Incident
    from .incidents import out

    cap = int(limit) if (limit is not None and int(limit) >= 1) else REOPEN_LIMIT
    rows = (await db.execute(
        select(Incident).where(Incident.reopen_count > cap).order_by(
            Incident.reopen_count.desc(), Incident.reported_at.desc(), Incident.id.desc()))).scalars().all()
    return {"incidents": [out(r) for r in rows], "flaggedPandits": await flagged_pandits(db, cap)}


async def flagged_pandit_ids(db, limit: int | None = None) -> list[str]:
    """Pandit ids currently flagged — feeds the booking review-hold
    (services/review_hold.py) and the pandit-module surfacing."""
    return [x["panditId"] for x in await flagged_pandits(db, limit)]


async def flagged_pandits(db, limit: int | None = None) -> list[dict]:
    from ..models import Incident, Pandit

    cap = int(limit) if (limit is not None and int(limit) >= 1) else REOPEN_LIMIT
    # cap is a validated int (>= 1): inline as literal — binding BOTH the WHERE
    # and HAVING params trips a SQLite edge case that yields an empty set
    # (mirrors the better-sqlite3 fix in server/services/incidents.js). The
    # window is every live reopened incident; the threshold applies to DISTINCT
    # bookings in HAVING so a single-booking loop never flags on volume.
    rows = (await db.execute(
        select(Incident.pandit_id, Pandit.name,
               func.sum(Incident.reopen_count), func.count(func.distinct(Incident.booking_id)),
               func.count(Incident.id), func.max(Incident.reported_at))
        .join(Pandit, Pandit.id == Incident.pandit_id, isouter=True)
        .where(Incident.reopen_count > 0, Incident.status.in_(("OPEN", "UNDER_REVIEW")))
        .group_by(Incident.pandit_id)
        .having(text(f"count(distinct booking_id) > {cap}"))
        .order_by(func.sum(Incident.reopen_count).desc(), Incident.pandit_id))).all()
    return [{"panditId": pid, "pandit": (name or ""), "reopens": (reopens or 0),
             "bookings": bookings or 0, "incidents": incidents or 0, "latest": latest}
            for pid, name, reopens, bookings, incidents, latest in rows]
