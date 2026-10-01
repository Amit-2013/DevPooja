"""Phases 27-29 — Communication engine: Python twin of server/services/comms.js.

ONE notification path with audience resolution, per-customer consent honouring
and delivery records; a campaign lifecycle state machine (DRAFT → SCHEDULED →
SENDING → SENT | FAILED, with CANCELLED from the not-yet-sent states); and a
stateless Excel import with dedupe preview for customers and leads.

Consent: users.pref carries { wa, sms, em } flags the customer controls in
their account. The engine honours them: WhatsApp needs wa, SMS needs sms,
Email needs em; Push/In-App are first-party and always allowed. A recipient
without consent or without a contact target is SKIPPED with the reason, not
silently dropped.

Commit contract (repo-wide lesson): every caller must await db.commit() after
service writes — route handlers do, scheduler passes do, tests must too.
"""
import json
import re
import time

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import AuditLog, Booking, Campaign, Lead, NotificationDelivery, Notif, User
from ..util import bad, conflict, j, not_found, v_int, v_one_of, v_str

CHANNELS = ["WhatsApp", "Email", "SMS", "Push", "In-App"]
AUDIENCES = ["All customers", "Repeat customers", "Plus members", "Flagged customers"]
STATUSES = ["DRAFT", "SCHEDULED", "SENDING", "SENT", "FAILED", "CANCELLED"]
IMPORT_KINDS = ["customers", "leads"]

_MOBILE_RE = re.compile(r"[6-9]\d{9}")


def _now_ms() -> int:
    return int(time.time() * 1000)


def out(c: Campaign) -> dict | None:
    """Campaign serialization — camelCase twin of comms.js out()."""
    if c is None:
        return None
    return {"id": c.id, "name": c.name, "channel": c.channel, "audience": c.audience,
            "status": c.status, "sent": c.sent or 0, "failed": c.failed or 0,
            "message": c.message or "", "scheduledAt": c.scheduled_at or None,
            "createdBy": c.created_by or None, "createdAt": c.created_at or None,
            "sentAt": c.sent_at or None}


async def record_delivery(db: AsyncSession, *, campaign_id: str | None, user_id: str,
                          channel: str, message: str, status: str, detail: str | None = None) -> None:
    db.add(NotificationDelivery(campaign_id=campaign_id, user_id=user_id, channel=channel,
                                message=message, status=status, detail=detail, ts=_now_ms()))


async def audience_ids(db: AsyncSession, audience: str) -> list[str]:
    """Audience resolution — twin of comms.js audienceIds()."""
    if audience == "Repeat customers":
        rows = (await db.execute(
            select(User.id).where(
                User.role == "customer",
                select(func.count())
                .select_from(Booking)
                .where(Booking.user_id == User.id,
                       Booking.status.notin_(("Cancelled", "PendingPayment")))
                .correlate(User).scalar_subquery() >= 2))).scalars().all()
        return list(rows)
    if audience == "Plus members":
        rows = (await db.execute(
            select(User.id).where(User.role == "customer", User.plus == 1))).scalars().all()
        return list(rows)
    if audience == "Flagged customers":
        from .reopen_digest import flagged_customers
        ids = [x["customerId"] for x in await flagged_customers(db)]
        return ids or [-1]
    rows = (await db.execute(select(User.id).where(User.role == "customer"))).scalars().all()
    return list(rows)


async def deliver(db: AsyncSession, *, campaign_id: str | None, user_id: str,
                  channel: str, message: str) -> str:
    """The ONE notification path: notifs row (the in-app store) + delivery record,
    plus consent honouring for customer channels. Returns the delivery status."""
    u = await db.get(User, user_id)
    if not u:
        await record_delivery(db, campaign_id=campaign_id, user_id=user_id, channel=channel,
                              message=message, status="FAILED", detail="unknown user")
        return "FAILED"
    pref = j(u.pref, {}) or {}
    if not isinstance(pref, dict):
        pref = {}
    if channel == "WhatsApp":
        has_target, consent = bool(u.mobile), pref.get("wa") is not False
    elif channel == "SMS":
        has_target, consent = bool(u.mobile), pref.get("sms") is not False
    elif channel == "Email":
        has_target, consent = bool(u.email), pref.get("em") is not False
    else:  # Push / In-App: first-party, always allowed
        has_target, consent = True, True
    if not has_target:
        await record_delivery(db, campaign_id=campaign_id, user_id=user_id, channel=channel,
                              message=message, status="SKIPPED",
                              detail=f"no {channel.lower()} target")
        return "SKIPPED"
    if not consent:
        await record_delivery(db, campaign_id=campaign_id, user_id=user_id, channel=channel,
                              message=message, status="SKIPPED",
                              detail=f"customer opted out of {channel.lower()}")
        return "SKIPPED"
    db.add(Notif(user_id=user_id, channel=channel, message=message, ts=_now_ms()))
    await record_delivery(db, campaign_id=campaign_id, user_id=user_id, channel=channel,
                          message=message, status="SENT", detail=None)
    return "SENT"


# --- Campaign lifecycle ------------------------------------------------------
async def get_campaign(db: AsyncSession, id: str) -> Campaign | None:
    return await db.get(Campaign, id)


async def _audit(db: AsyncSession, actor: str | None, action: str, entity: str,
                 entity_id: str | None, detail: dict, reason: str | None = None) -> None:
    """Node parity (server/lib/audit.js + incidents.py precedent): actor_role is
    derived from the users row, never assumed; created_at is explicit."""
    role = None
    if actor:
        u = await db.get(User, actor)
        role = u.role if u else "system"
    db.add(AuditLog(actor_user_id=actor or None, actor_role=role, action=action,
                    entity=entity, entity_id=entity_id, detail=json.dumps(detail),
                    reason=reason, created_at=_now_ms()))


async def create(db: AsyncSession, body: dict, actor: str | None) -> dict:
    from .bookings import next_seq

    body = body or {}
    cid = "C" + str(await next_seq(db, "campaign_seq", 3))
    c = Campaign(
        id=cid,
        name=v_str(body.get("name"), "Name", max_len=80),
        channel=v_one_of(body.get("channel"), CHANNELS, "Channel"),
        audience=v_one_of(body.get("audience"), AUDIENCES, "Audience"),
        message=v_str(body.get("message") or "", "Message", optional=True, max_len=300),
        status="DRAFT", sent=0, failed=0,
        scheduled_at=None, created_by=actor, created_at=_now_ms(), sent_at=None,
    )
    db.add(c)
    await db.flush()
    await _audit(db, actor, "campaign.created", "campaign", cid,
                 {"name": c.name, "channel": c.channel, "audience": c.audience})
    c2 = await get_campaign(db, cid)
    return out(c2)


async def update(db: AsyncSession, id: str, body: dict, actor: str | None) -> dict:
    body = body or {}
    c = await get_campaign(db, id)
    if not c:
        raise not_found("Campaign not found")
    if c.status != "DRAFT":
        raise conflict("Only DRAFT campaigns can be edited")
    name = c.name if body.get("name") is None else v_str(body["name"], "Name", max_len=80)
    channel = c.channel if body.get("channel") is None else v_one_of(body["channel"], CHANNELS, "Channel")
    audience = c.audience if body.get("audience") is None else v_one_of(body["audience"], AUDIENCES, "Audience")
    message = c.message if body.get("message") is None else v_str(
        body.get("message") or "", "Message", optional=True, max_len=300)
    c.name, c.channel, c.audience, c.message = name, channel, audience, message
    await _audit(db, actor, "campaign.updated", "campaign", id,
                 {"name": name, "channel": channel, "audience": audience})
    await db.flush()
    return out(await get_campaign(db, id))


async def schedule(db: AsyncSession, id: str, body: dict, actor: str | None) -> dict:
    body = body or {}
    c = await get_campaign(db, id)
    if not c:
        raise not_found("Campaign not found")
    if c.status != "DRAFT":
        raise conflict("Only DRAFT campaigns can be scheduled")
    msg = v_str((body.get("message") or c.message or ""), "Message", max_len=300)
    now = _now_ms()
    when = v_int(body.get("scheduledAt"), "Scheduled time",
                 min_val=now - 1000, max_val=now + 366 * 86400000) if body.get("scheduledAt") else now
    c.status, c.message, c.scheduled_at = "SCHEDULED", msg, when
    await _audit(db, actor, "campaign.scheduled", "campaign", id, {"when": when})
    await db.flush()
    return out(await get_campaign(db, id))


async def cancel(db: AsyncSession, id: str, actor: str | None, reason: str | None = None) -> dict:
    c = await get_campaign(db, id)
    if not c:
        raise not_found("Campaign not found")
    if c.status not in ("DRAFT", "SCHEDULED"):
        raise conflict("Only not-yet-sent campaigns can be cancelled")
    prev = c.status
    c.status = "CANCELLED"
    await _audit(db, actor, "campaign.cancelled", "campaign", id, {"from": prev}, reason)
    await db.flush()
    return out(await get_campaign(db, id))


async def send(db: AsyncSession, id: str, actor: str | None, reason: str | None = None) -> dict:
    """The send: DRAFT (send now) or SCHEDULED (due). Marks SENDING first so a
    crash mid-send is visible; per-recipient failures do not abort the send."""
    c = await get_campaign(db, id)
    if not c:
        raise not_found("Campaign not found")
    if c.status in ("SENT", "FAILED", "CANCELLED"):
        raise conflict("This campaign has already finished")
    if c.status == "SENDING":
        raise conflict("This campaign is already sending")
    msg = v_str(c.message or "", "Message", max_len=300)
    targets = await audience_ids(db, c.audience)
    c.status = "SENDING"
    await db.flush()
    sent = failed = 0
    for uid in targets:
        st = await deliver(db, campaign_id=id, user_id=str(uid), channel=c.channel, message=msg)
        if st == "SENT":
            sent += 1
        elif st == "FAILED":
            failed += 1
    c.status = "FAILED" if (failed and not sent) else "SENT"
    c.sent, c.failed, c.sent_at = sent, failed, _now_ms()
    await _audit(db, actor, "campaign.sent", "campaign", id,
                 {"audience": c.audience, "sent": sent, "failed": failed}, reason)
    await db.flush()
    return {**out(await get_campaign(db, id)), "delivered": sent,
            "skipped": len(targets) - sent - failed}


async def detail(db: AsyncSession, id: str) -> dict:
    c = await get_campaign(db, id)
    if not c:
        raise not_found("Campaign not found")
    rows = (await db.execute(
        select(NotificationDelivery.status, func.count())
        .where(NotificationDelivery.campaign_id == id)
        .group_by(NotificationDelivery.status))).all()
    d = {"SENT": 0, "SKIPPED": 0, "FAILED": 0}
    for status, n in rows:
        d[status] = n
    rec = (await db.execute(
        select(NotificationDelivery.user_id, NotificationDelivery.channel,
               NotificationDelivery.status, NotificationDelivery.detail,
               NotificationDelivery.ts)
        .where(NotificationDelivery.campaign_id == id)
        .order_by(NotificationDelivery.ts.desc(), NotificationDelivery.id.desc())
        .limit(500))).all()
    return {"campaign": out(c), "deliveries": d,
            "rows": [{"userId": u, "channel": ch, "status": s, "detail": dt, "ts": ts}
                     for u, ch, s, dt, ts in rec]}


async def list_campaigns(db: AsyncSession) -> list[dict]:
    rows = (await db.execute(
        select(Campaign).order_by(Campaign.created_at.desc().nullslast(), Campaign.id.desc())
    )).scalars().all()
    return [out(c) for c in rows]


# --- Due-campaign sweep (boot-armed, like the other sweeps) ------------------
# Boot tick is the catch-up: a campaign scheduled while the server was down
# fires on the first boot after its scheduled_at. CAMPAIGN_SWEEP_MS env,
# default 60s; 0 disables. Tests drive due_sweep() directly.
async def due_sweep(db: AsyncSession) -> int:
    due = (await db.execute(
        select(Campaign.id).where(Campaign.status == "SCHEDULED",
                                  Campaign.scheduled_at <= _now_ms()))).scalars().all()
    sent = 0
    for cid in due:
        try:
            await send(db, cid, None)
            sent += 1
        except Exception as e:  # one bad campaign must not stop the sweep
            print(f"[campaigns] {e}")
            await db.rollback()
    return sent


# --- Excel import with dedupe preview (stateless: preview then commit) -------
_LEAD_SOURCES = ["Contact", "Corporate", "Astrology", "Kundli", "Partner", "Walk-in", "Other"]


async def import_preview(db: AsyncSession, kind: str, rows: list[dict]) -> dict:
    if kind not in IMPORT_KINDS:
        raise bad("Unknown import kind")
    seen: dict[str, int] = {}
    result = {"total": 0, "valid": 0, "invalid": 0, "willCreate": 0, "willUpdate": 0,
              "duplicatesInFile": 0, "existing": 0, "errors": [], "preview": []}
    for r in rows:
        result["total"] += 1
        row_no = result["total"]
        if kind == "customers":
            name = str(r.get("name") or "").strip()[:120]
            mobile = re.sub(r"\D", "", str(r.get("mobile") or ""))
            if not name or len(name) > 120:
                result["invalid"] += 1
                result["errors"].append({"row": row_no, "error": "name is required"})
                continue
            if not _MOBILE_RE.fullmatch(mobile):
                result["invalid"] += 1
                result["errors"].append({"row": row_no, "error": "a valid 10-digit mobile is required"})
                continue
            key = "m:" + mobile
            if key in seen:
                result["duplicatesInFile"] += 1
                result["errors"].append({"row": row_no,
                                         "error": f"duplicate of row {seen[key]} in this file"})
                continue
            seen[key] = row_no
            exist = (await db.execute(
                select(User.id).where(User.mobile == mobile))).scalar_one_or_none()
            if exist:
                result["existing"] += 1
                result["willUpdate"] += 1
                result["preview"].append({"row": row_no, "action": "update",
                                          "mobile": mobile, "name": name})
            else:
                result["willCreate"] += 1
                result["preview"].append({"row": row_no, "action": "create",
                                          "mobile": mobile, "name": name})
            result["valid"] += 1
        else:  # leads
            name = str(r.get("name") or "").strip()[:120]
            mobile = re.sub(r"\D", "", str(r.get("mobile") or ""))
            details = str(r.get("details") or "").strip()[:800]
            source = r.get("source") if r.get("source") in _LEAD_SOURCES else "Other"
            if not name:
                result["invalid"] += 1
                result["errors"].append({"row": row_no, "error": "name is required"})
                continue
            if mobile and not _MOBILE_RE.fullmatch(mobile):
                result["invalid"] += 1
                result["errors"].append({"row": row_no, "error": "invalid mobile"})
                continue
            key = ("m:" + mobile) if mobile else ("n:" + name.lower())
            if key in seen:
                result["duplicatesInFile"] += 1
                result["errors"].append({"row": row_no,
                                         "error": f"duplicate of row {seen[key]} in this file"})
                continue
            seen[key] = row_no
            exist = (await db.execute(
                select(Lead.id).where(Lead.mobile == mobile))).scalar_one_or_none() if mobile else None
            if exist:
                result["existing"] += 1
                result["willUpdate"] += 1
                result["preview"].append({"row": row_no, "action": "update", "mobile": mobile,
                                          "name": name, "details": details, "source": source})
            else:
                result["willCreate"] += 1
                result["preview"].append({"row": row_no, "action": "create", "mobile": mobile,
                                          "name": name, "details": details, "source": source})
            result["valid"] += 1
    return result


async def import_commit(db: AsyncSession, kind: str, rows: list[dict], actor: str | None,
                        reason: str | None = None) -> dict:
    if kind not in IMPORT_KINDS:
        raise bad("Unknown import kind")
    pv = await import_preview(db, kind, rows)
    if not pv["willCreate"] and not pv["willUpdate"]:
        return {"committed": 0, **pv}
    committed = 0
    if kind == "customers":
        for p in pv["preview"]:
            if p["action"] == "create":
                uid = "u" + str(_now_ms() + committed)
                db.add(User(id=uid, role="customer", name=p["name"], mobile=p["mobile"],
                            pts=0, plus=0, pref="{}", addr="[]", fam="[]",
                            joined=time.strftime("%Y-%m-%d"), created_at=_now_ms()))
            else:
                await db.execute(text(
                    "UPDATE users SET name=:n WHERE mobile=:m").bindparams(n=p["name"], m=p["mobile"]))
            committed += 1
    else:  # leads — the ONE writer for leads is services/leads.py (Phase 26)
        from .leads import capture
        for p in pv["preview"]:
            if p["action"] == "create":
                await capture(db, {"source": p.get("source") or "Other", "name": p["name"],
                                   "mobile": p.get("mobile") or "", "details": p.get("details") or ""},
                              actor)
            else:
                await db.execute(text(
                    "UPDATE leads SET name=:n WHERE mobile=:m").bindparams(n=p["name"], m=p["mobile"]))
            committed += 1
    await _audit(db, actor, "import.committed", kind, None,
                 {"committed": committed, "total": pv["total"]}, reason)
    await db.flush()
    return {"committed": committed, **pv}
