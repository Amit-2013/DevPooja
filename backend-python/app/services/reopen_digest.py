"""Phase 20 follow-up: repeat-reopen digest — the Operations-tab review queue.

An incident dismissed-and-reopened more than REOPEN_LIMIT times (default 2) is
a systemic signal: recurring conduct/safety issues, disputed dismissals, or a
pandit stuck in a loop one-off triage keeps losing. Reopened incidents are
live queue items (they return to UNDER_REVIEW), so the digest lists exactly
those, newest reopen first. Mirrors server/services/incidents.js reopenDigest.
"""
from sqlalchemy import select

REOPEN_LIMIT = 2


async def reopen_digest(db, limit: int | None = None) -> list[dict]:
    from ..models import Incident
    from .incidents import out

    cap = int(limit) if (limit is not None and int(limit) >= 1) else REOPEN_LIMIT
    q = select(Incident).where(Incident.reopen_count > cap).order_by(
        Incident.reopen_count.desc(), Incident.reported_at.desc(), Incident.id.desc())
    return [out(r) for r in (await db.execute(q)).scalars().all()]
