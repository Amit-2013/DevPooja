"""Incident reporting (master plan Phase 20) — async twin of
server/services/incidents.js. Activates the migration-014 `incidents` table
(schema unchanged; the Incident model already exists).

Who reports: the PANDIT assigned to a booking (on-ground safety and conduct
channel). A report may reference the booking — the customer is linked from it.
Ownership is enforced: a pandit can only report against a booking assigned to
them and only read their own reports.

Categories (fixed vocabulary): SAFETY_CONCERN, CUSTOMER_CONDUCT, PAYMENT_ISSUE,
SAMAGRI_ISSUE, OTHER.

Admin triage: OPEN -> UNDER_REVIEW -> RESOLVED | DISMISSED.
UNDER_REVIEW requires an admin note; RESOLVED requires a resolution the pandit
sees; DISMISSED requires a reason. Closed states are terminal.

Evidence: /media URLs produced by the EXISTING magic-checked upload pipeline,
stored as a JSON array (never trusted from the client directly).

Every write is audited (incident.reported / incident.triage) with old->new;
the pandit is notified on triage; admins are notified of new reports.
"""
import json
import time

from sqlalchemy import select

from ..models import AuditLog, Booking, Incident, Notif, Pandit, User
from ..util import bad, conflict, not_found, rid

CATEGORIES = ["SAFETY_CONCERN", "CUSTOMER_CONDUCT", "PAYMENT_ISSUE", "SAMAGRI_ISSUE", "OTHER"]
STATUSES = ["OPEN", "UNDER_REVIEW", "RESOLVED", "DISMISSED"]
CLOSED = ["RESOLVED", "DISMISSED"]


def _now_ms() -> int:
    return int(time.time() * 1000)


def out(r: Incident) -> dict:
    try:
        evidence = json.loads(r.evidence or "[]")
    except (TypeError, ValueError):
        evidence = []
    return {"id": r.id, "panditId": r.pandit_id, "bookingId": r.booking_id,
            "customerId": r.customer_id, "category": r.category, "description": r.description,
            "evidence": evidence, "status": r.status, "adminNotes": r.admin_notes or "",
            "resolution": r.resolution or "", "reportedAt": r.reported_at,
            "resolvedAt": r.resolved_at}


async def list_incidents(db, status: str | None = None) -> list[dict]:
    q = select(Incident).order_by(Incident.reported_at.desc(), Incident.id.desc())
    if status and status in STATUSES:
        q = q.where(Incident.status == status)
    return [out(r) for r in (await db.execute(q)).scalars().all()]


async def for_pandit(db, pandit_id: str) -> list[dict]:
    rows = (await db.execute(select(Incident).where(Incident.pandit_id == pandit_id)
                             .order_by(Incident.reported_at.desc(), Incident.id.desc()))).scalars().all()
    return [out(r) for r in rows]


async def counts(db) -> dict:
    rows = (await db.execute(select(Incident.status))).scalars().all()
    c = {s: 0 for s in STATUSES}
    for s in rows:
        c[s] = c.get(s, 0) + 1
    return c


async def _audit(db, actor, action, entity, entity_id, detail, old_value=None, new_value=None) -> None:
    """Node parity: actor_role is derived from the users row (a pandit reporting
    is a `pandit` actor, an admin triaging is `admin`), never assumed."""
    role = None
    if actor:
        u = await db.get(User, actor)
        role = u.role if u else "system"
    db.add(AuditLog(actor_user_id=actor or None, actor_role=role,
                    action=action, entity=entity, entity_id=entity_id,
                    detail=json.dumps(detail),
                    old_value=json.dumps(old_value) if old_value is not None else None,
                    new_value=json.dumps(new_value) if new_value is not None else None,
                    created_at=_now_ms()))


async def report(db, pandit_id: str, body: dict) -> dict:
    p = await db.get(Pandit, pandit_id)
    if not p:
        raise not_found("Pandit not found")
    b = body or {}
    category = b.get("category")
    if category not in CATEGORIES:
        raise bad("Unknown incident category")
    desc = str(b.get("description") or "").strip()
    if len(desc) < 10:
        raise bad("Describe the incident in at least 10 characters")
    booking_id = b.get("bookingId")
    customer_id = None
    booking = None
    if booking_id:
        booking = (await db.execute(select(Booking).where(Booking.id == str(booking_id)))).scalar_one_or_none()
        if not booking:
            raise not_found("Booking not found")
        if booking.pandit_id != pandit_id:
            raise bad("You can only report incidents for bookings assigned to you")
        customer_id = booking.user_id
    urls = [u[:200] for u in (b.get("evidence") or [])
            if isinstance(u, str) and u.startswith("/media/")][:8]
    iid = "INC" + rid(6)
    db.add(Incident(id=iid, pandit_id=pandit_id, booking_id=booking.id if booking else None,
                    customer_id=customer_id, category=category, description=desc[:2000],
                    evidence=json.dumps(urls), status="OPEN", reported_at=_now_ms()))
    await db.flush()
    # actor is the pandit's USER id — audit roles derive from the users row
    await _audit(db, p.user_id or pandit_id, "incident.reported", "incident", iid,
                 {"category": category, "bookingId": booking.id if booking else None,
                  "evidenceCount": len(urls)},
                 new_value={"status": "OPEN", "category": category})
    admins = (await db.execute(select(User.id).where(User.role == "admin"))).scalars().all()
    for a in admins:
        db.add(Notif(user_id=a, channel="In-App",
                     message=f"New incident {iid} ({category}) reported by {p.name}" +
                             (f" on booking {booking.id}." if booking else "."),
                     ts=_now_ms()))
    return out(await db.get(Incident, iid))


async def triage(db, actor, iid: str, body: dict) -> dict:
    row = await db.get(Incident, iid)
    if not row:
        raise not_found("Incident not found")
    b = body or {}
    status = b.get("status")
    if status not in STATUSES:
        raise bad("Unknown incident status")
    if row.status in CLOSED:
        raise conflict(f"Incident already {row.status} — the audit trail keeps the history")
    notes = b.get("notes")
    resolution = b.get("resolution")
    reason = b.get("reason")
    if status == "UNDER_REVIEW" and not str(notes or "").strip():
        raise bad("Say what is being reviewed (admin note required)")
    if status == "RESOLVED" and not str(resolution or "").strip():
        raise bad("A resolution is required — the pandit will see it")
    if status == "DISMISSED" and not str(reason or "").strip():
        raise bad("A dismissal reason is required")
    old = row.status
    row.status = status
    if notes is not None:
        row.admin_notes = str(notes)[:1000]
    if status == "RESOLVED":
        row.resolution = str(resolution)[:1000]
        row.resolved_at = _now_ms()
    await db.flush()
    detail = {"from": old, "to": status}
    if notes is not None:
        detail["notes"] = str(notes)[:200]
    if status == "RESOLVED":
        detail["resolution"] = str(resolution)[:200]
    if status == "DISMISSED":
        detail["reason"] = str(reason)[:200]
    await _audit(db, actor, "incident.triage", "incident", iid, detail,
                 old_value={"status": old}, new_value={"status": status})
    p = await db.get(Pandit, row.pandit_id)
    if p and p.user_id:
        msg = (f"Your incident {iid} is under review." if status == "UNDER_REVIEW" else
               f"Your incident {iid} is resolved: {str(resolution)[:160]}" if status == "RESOLVED" else
               f"Your incident {iid} was reviewed and not actionable: {str(reason)[:160]}")
        db.add(Notif(user_id=p.user_id, channel="In-App", message=msg, ts=_now_ms()))
    return out(row)
