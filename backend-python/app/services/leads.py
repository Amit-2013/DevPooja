"""Phase 26 — Leads CRM: twin of server/services/leads.js. The ONE writer for
the leads table. A lead is a prospective customer captured from a public
enquiry (contact / corporate / astrology / kundli forms), the pandit partner
form or manual admin entry; the pipeline NEW → CONTACTED → QUALIFIED →
CONVERTED | LOST is what turns enquiries into bookings. `type` doubles as the
capture SOURCE (the legacy rows only ever came from the four enquiry forms)."""
import json
import time

from sqlalchemy import String, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import AuditLog, Lead, User
from ..util import bad, conflict, not_found, v_email, v_int, v_mobile, v_one_of, v_str

SOURCES = ["Contact", "Corporate", "Astrology", "Kundli", "Partner", "Walk-in", "Other"]
PUBLIC_SOURCES = ["Contact", "Corporate", "Astrology", "Kundli"]
STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "CONVERTED", "LOST"]
LIVE = ["NEW", "CONTACTED", "QUALIFIED"]

_audit = lambda db, **kw: db.add(AuditLog(**kw))


def out(l: Lead) -> dict | None:
    if l is None:
        return None
    return {"id": l.id, "type": l.type, "name": l.name, "details": l.details or "",
            "date": l.date, "mobile": l.mobile or "", "email": l.email or "",
            "service": l.service or "", "location": l.location or "",
            "assignedTo": l.assigned_to or None, "status": l.status,
            "followUpAt": l.follow_up_at or None,
            "convertedBookingId": l.converted_booking_id or None}


async def _capture_input(body: dict, *, public: bool) -> dict:
    src = v_one_of(body.get("source") or body.get("type"),
                   PUBLIC_SOURCES if public else SOURCES, "Source")
    mobile = v_mobile(body.get("mobile")) if body.get("mobile") else ""
    email = v_email(body.get("email")) if body.get("email") else ""
    # Contact channels are optional at capture (the kundli form never had one)
    # but VALIDATED when present; reachability is enforced at conversion time.
    name = v_str(body.get("name"), "Name", max_len=120)
    return {"source": src, "name": name, "mobile": mobile, "email": email,
            "service": str(body.get("service") or "").strip()[:120],
            "location": str(body.get("location") or "").strip()[:120],
            "notes": str(body.get("notes") or body.get("details") or "").strip()[:800]}


async def capture(db: AsyncSession, body: dict, actor: str | None = None, ip: str = "") -> dict:
    """Public/admin capture. Returns the created lead."""
    i = await _capture_input(body or {}, public=not actor)
    lead = Lead(type=i["source"], name=i["name"], details=i["notes"],
                date=time.strftime("%Y-%m-%d"), mobile=i["mobile"], email=i["email"],
                service=i["service"], location=i["location"], status="NEW")
    db.add(lead)
    await db.flush()
    _audit(db, actor_user_id=actor or None, actor_role="admin" if actor else "public",
           action="lead.captured", entity="lead", entity_id=str(lead.id),
           detail=json.dumps({"source": lead.type, "name": lead.name,
                              "hasContact": bool(lead.mobile or lead.email)}),
           ip=(ip or None) if not actor else None,
           created_at=int(time.time() * 1000))
    return out(lead)


async def list_leads(db: AsyncSession, f: dict) -> dict:
    """Admin list with filters: ?status (exact or comma-list), ?q (name/mobile/
    email/notes/id LIKE), ?source, ?assigned, ?from/?to (YYYY-MM-DD on the
    capture date), ?followup=1 (due live rows). Newest first."""
    w, p = [], {}
    statuses = [s.strip() for s in str(f.get("status") or "").split(",") if s.strip() in STATUSES]
    if statuses:
        w.append(Lead.status.in_(statuses))
    if f.get("source") in SOURCES:
        w.append(Lead.type == f["source"])
    if f.get("assigned"):
        w.append(Lead.assigned_to == f["assigned"])
    if f.get("from"):
        w.append(Lead.date >= str(f["from"]))
    if f.get("to"):
        w.append(Lead.date <= str(f["to"]))
    if f.get("followup"):
        w.append(Lead.follow_up_at.is_not(None))
        w.append(Lead.follow_up_at <= int(time.time() * 1000))
        w.append(Lead.status.in_(LIVE))
    q = str(f.get("q") or "").replace("%", "").replace("_", "").strip()
    if q:
        like = f"%{q}%"
        w.append(or_(Lead.name.like(like), Lead.mobile.like(like), Lead.email.like(like),
                     Lead.details.like(like), cast(Lead.id, String) == q))
    stmt = select(Lead)
    if w:
        from sqlalchemy import and_
        stmt = stmt.where(and_(*w))
    rows = (await db.execute(stmt.order_by(Lead.id.desc()).limit(500))).scalars().all()
    counts = {s: 0 for s in STATUSES}
    for r in (await db.execute(select(Lead.status, func.count()).group_by(Lead.status))).all():
        counts[r[0]] = r[1]
    return {"leads": [out(r) for r in rows], "counts": counts}


async def _one(db: AsyncSession, lead_id) -> Lead:
    l = await db.get(Lead, int(lead_id))
    if not l:
        raise not_found("Lead not found")
    return l


async def set_status(db: AsyncSession, lead_id, status: str, reason: str | None, actor: str) -> dict:
    l = await _one(db, lead_id)
    if status not in STATUSES:
        raise bad("Status is invalid")
    if l.status == "CONVERTED":
        raise conflict("A converted lead is closed — the booking carries the history")
    if l.status == status:
        return out(l)
    if status == "LOST" and not str(reason or "").strip():
        raise bad("A reason is required to mark a lead lost")
    db.add(AuditLog(actor_user_id=actor, actor_role="admin", action="lead.status",
                    entity="lead", entity_id=str(l.id),
                    detail=json.dumps({"from": l.status, "to": status}),
                    old_value=json.dumps({"status": l.status}),
                    new_value=json.dumps({"status": status}),
                    reason=str(reason)[:300] if (status == "LOST" and reason) else None,
                    created_at=int(time.time() * 1000)))
    l.status = status
    return out(l)


async def assign(db: AsyncSession, lead_id, user_id: str | None, actor: str) -> dict:
    l = await _one(db, lead_id)
    if user_id and not await db.get(User, user_id):
        raise bad("Unknown assignee")
    db.add(AuditLog(actor_user_id=actor, actor_role="admin", action="lead.assign",
                    entity="lead", entity_id=str(l.id),
                    detail=json.dumps({"from": l.assigned_to, "to": user_id or None}),
                    created_at=int(time.time() * 1000)))
    l.assigned_to = user_id or None
    return out(l)


async def schedule_follow_up(db: AsyncSession, lead_id, when, actor: str) -> dict:
    l = await _one(db, lead_id)
    t = v_int(when, "Follow-up time", min_val=0, max_val=int(time.time() * 1000) + 366 * 86400000)
    db.add(AuditLog(actor_user_id=actor, actor_role="admin", action="lead.followup",
                    entity="lead", entity_id=str(l.id),
                    detail=json.dumps({"from": l.follow_up_at, "to": t}),
                    created_at=int(time.time() * 1000)))
    l.follow_up_at = t
    return out(l)


async def update_notes(db: AsyncSession, lead_id, notes, actor: str) -> dict:
    l = await _one(db, lead_id)
    n = v_str(notes, "Notes", max_len=800)
    db.add(AuditLog(actor_user_id=actor, actor_role="admin", action="lead.notes",
                    entity="lead", entity_id=str(l.id),
                    detail=json.dumps({"from": (l.details or "")[:80], "to": n[:80]}),
                    created_at=int(time.time() * 1000)))
    l.details = n
    return out(l)


async def convert(db: AsyncSession, lead_id, body: dict, actor: str) -> dict:
    """The money move: a lead becomes a real manual booking via the EXISTING
    bookings engine (admin_manual — creates/finds the customer by mobile,
    prices through shared pricing). The lead closes as CONVERTED."""
    from .bookings import admin_manual

    l = await _one(db, lead_id)
    if l.status == "CONVERTED":
        raise conflict("Lead already converted")
    if not l.mobile:
        raise bad("Add a mobile number to the lead before converting it to a booking")
    body = body or {}
    booking = await admin_manual(db, {
        "name": l.name, "mobile": l.mobile, "mode": body.get("mode") or "home",
        "slot": body.get("slot") or "10:00 AM",
        "date": body.get("date") or time.strftime("%Y-%m-%d", time.localtime(time.time() + 7 * 86400)),
        "pujaId": body.get("pujaId") or "satyanarayan", "city": l.location or None})
    db.add(AuditLog(actor_user_id=actor, actor_role="admin", action="lead.converted",
                    entity="lead", entity_id=str(l.id),
                    detail=json.dumps({"from": l.status, "to": "CONVERTED",
                                       "bookingId": booking.id}),
                    old_value=json.dumps({"status": l.status}),
                    new_value=json.dumps({"status": "CONVERTED",
                                          "convertedBookingId": booking.id}),
                    created_at=int(time.time() * 1000)))
    l.status = "CONVERTED"
    l.converted_booking_id = booking.id
    return {"lead": out(l), "bookingId": booking.id}


async def remove(db: AsyncSession, lead_id, actor: str) -> dict:
    l = await _one(db, lead_id)
    if l.status in LIVE:
        raise conflict("Live leads are never deleted — mark them LOST with a reason instead")
    db.add(AuditLog(actor_user_id=actor, actor_role="admin", action="lead.deleted",
                    entity="lead", entity_id=str(l.id),
                    detail=json.dumps({"status": l.status}),
                    created_at=int(time.time() * 1000)))
    await db.delete(l)
    return {"ok": True}
