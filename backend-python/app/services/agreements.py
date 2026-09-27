"""Pandit agreement management (master plan Phases 23-25) — twin of
server/services/agreements.js. Activates the `agreements` +
`agreement_acceptances` tables scaffolded by migration 014.

Model (mirrors the Node twin exactly):
- An agreement is a VERSION ROW, never mutated after publishing; a new draft of
  the same document family gets version = max(version)+1 (Phase 23).
- `publish` stamps published_at + document_hash = sha256(body).
- `archive` is refused for versions with acceptances — signed copies stay
  accessible; supersede them by publishing a higher version instead.
- Acceptance (Phase 24) is version-locked (unique index on agreement_id +
  pandit_id; a repeat raises IntegrityError -> 409) and records the verified
  OTP flag, method, IP and device + an enriched audit record.
- Manual upload (Phase 25): an admin publishes a scanned signed agreement (PDF)
  as its own version — method MANUAL, no OTP row is fabricated.

The OTP is issued through the existing public `POST /api/auth/otp/send` against
the pandit's registered mobile (pandits.mobile) and verified via
services.otp.verify — no parallel OTP path. Demo OTP = 123456.
"""
import hashlib
import time

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..models import Agreement, AgreementAcceptance, AuditLog, Notif, Pandit
from ..util import bad, conflict, not_found, rid

STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"]
METHODS = ["DIGITAL", "MANUAL"]


def _audit(db, uid, action, entity, entity_id, detail, reason=None, old=None, new=None,
           ip=None, device=None):
    db.add(AuditLog(actor_user_id=uid, actor_role="admin" if uid else "system",
                    action=action, entity=entity, entity_id=entity_id,
                    detail=detail if isinstance(detail, str) else _j(detail),
                    old_value=_j(old) if old is not None else None,
                    new_value=_j(new) if new is not None else None,
                    reason=reason, ip=(str(ip)[:60] if ip else None),
                    device=(str(device)[:200] if device else None),
                    created_at=int(time.time() * 1000)))


def _j(x) -> str:
    import json
    return json.dumps(x, ensure_ascii=False)


def out(r: Agreement) -> dict:
    return {"id": r.id, "version": r.version, "title": r.title, "status": r.status,
            "documentHash": r.document_hash, "fileName": r.file_name, "createdBy": r.created_by,
            "effectiveFrom": r.effective_from, "createdAt": r.created_at,
            "publishedAt": r.published_at, "archivedAt": r.archived_at,
            "body": r.body, "acceptanceCount": getattr(r, "acceptance_count", None)}


async def current(db) -> Agreement | None:
    row = (await db.execute(select(Agreement).where(Agreement.status == "PUBLISHED")
                            .order_by(Agreement.version.desc()).limit(1))).scalars().first()
    if row:
        ids = (await db.execute(
            select(AgreementAcceptance.id).where(AgreementAcceptance.agreement_id == row.id))).scalars().all()
        row.acceptance_count = len(ids)
    return row


async def _next_version(db) -> int:
    # max(version) across the document family; fresh DB starts at 1.
    versions = [r[0] for r in (await db.execute(select(Agreement.version))).all()]
    return (max(versions) if versions else 0) + 1


async def create_draft(db, *, uid: str, title: str, body: str,
                       effective_from: str | None = None) -> Agreement:
    if not str(title or "").strip():
        raise bad("A title is required")
    if not str(body or "").strip():
        raise bad("The agreement text is required")
    row = Agreement(id="agr" + rid(6), version=await _next_version(db), title=str(title)[:200],
                    body=str(body), status="DRAFT", created_by=uid or None,
                    effective_from=(str(effective_from)[:10] if effective_from else None),
                    created_at=int(time.time() * 1000))
    db.add(row)
    await db.flush()
    _audit(db, uid, "agreement.created", "agreement", row.id,
           {"version": row.version, "title": str(title)[:120]})
    return row


async def publish(db, agreement_id: str, actor_uid: str, *, reason: str | None = None) -> Agreement:
    row = await db.get(Agreement, agreement_id)
    if not row:
        raise not_found("Agreement not found")
    if row.status == "ARCHIVED":
        raise conflict("An archived agreement cannot be published again")
    if row.status == "PUBLISHED":
        raise conflict("Agreement is already published")
    h = hashlib.sha256(row.body.encode("utf-8")).hexdigest()
    row.status = "PUBLISHED"
    row.document_hash = h
    row.published_at = int(time.time() * 1000)
    await db.flush()
    _audit(db, actor_uid, "agreement.published", "agreement", row.id,
           {"version": row.version, "hash": h}, reason=reason,
           old={"status": "DRAFT"}, new={"status": "PUBLISHED", "hash": h})
    return row


async def archive(db, agreement_id: str, actor_uid: str, *, reason: str | None = None) -> Agreement:
    row = await db.get(Agreement, agreement_id)
    if not row:
        raise not_found("Agreement not found")
    if row.status == "ARCHIVED":
        raise conflict("Agreement is already archived")
    accepted = len((await db.execute(select(AgreementAcceptance.id).where(
        AgreementAcceptance.agreement_id == agreement_id))).scalars().all())
    if accepted > 0:
        raise conflict(f"{row.version} has {accepted} acceptance(s) — publish a new version instead; "
                       "accepted versions are never overwritten")
    was = row.status
    row.status = "ARCHIVED"
    row.archived_at = int(time.time() * 1000)
    await db.flush()
    _audit(db, actor_uid, "agreement.archived", "agreement", row.id,
           {"version": row.version}, reason=reason,
           old={"status": was}, new={"status": "ARCHIVED"})
    return row


async def manual_upload(db, *, uid: str, title: str, file_name: str, data: bytes,
                        effective_from: str | None = None) -> Agreement:
    if not str(title or "").strip():
        raise bad("A title is required")
    if not file_name:
        raise bad("Attach the signed agreement file")
    h = hashlib.sha256(data).hexdigest()
    row = Agreement(id="agr" + rid(6), version=await _next_version(db), title=str(title)[:200],
                    body="", status="PUBLISHED", document_hash=h, file_name=file_name,
                    created_by=uid or None,
                    effective_from=(str(effective_from)[:10] if effective_from else None),
                    created_at=int(time.time() * 1000), published_at=int(time.time() * 1000))
    db.add(row)
    await db.flush()
    _audit(db, uid, "agreement.uploaded", "agreement", row.id,
           {"version": row.version, "fileName": str(file_name)[:120], "hash": h, "method": "MANUAL"},
           reason="Signed agreement uploaded manually")
    return row


async def accept(db, *, pid: str, uid: str, agreement_id: str, consent, otp,
                 ip: str | None = None, device: str | None = None) -> AgreementAcceptance:
    from .otp import verify as otp_verify

    if not consent:
        raise bad("Tick the consent box to accept the agreement")
    a = await db.get(Agreement, agreement_id)
    # Unknown AND not-yet-published ids are indistinguishable to pandits.
    if not a or a.status != "PUBLISHED":
        raise not_found("Agreement not found")
    pandit = await db.get(Pandit, pid)
    if not pandit:
        raise not_found("Pandit not found")
    if not pandit.mobile:
        raise bad("Your account has no registered mobile number — add one before accepting")
    if not otp:
        raise bad("Enter the OTP sent to your registered mobile")
    dup = (await db.execute(select(AgreementAcceptance.id).where(
        AgreementAcceptance.agreement_id == agreement_id,
        AgreementAcceptance.pandit_id == pid))).scalar_one_or_none()
    if dup:
        raise conflict("You have already accepted version " + str(a.version))
    await otp_verify(db, pandit.mobile, str(otp))
    row = AgreementAcceptance(id="agc" + rid(6), agreement_id=agreement_id, pandit_id=pid,
                              method="DIGITAL", otp_verified=1,
                              ip=(str(ip)[:60] if ip else None),
                              device=(str(device)[:200] if device else None),
                              accepted_at=int(time.time() * 1000))
    db.add(row)
    try:
        await db.flush()
    except IntegrityError:
        # The migration-014 unique index is the real version lock (race-safe).
        raise conflict("You have already accepted version " + str(a.version))
    _audit(db, uid, "agreement.accepted", "agreement_acceptance", row.id,
           {"agreementId": agreement_id, "version": a.version, "method": "DIGITAL",
            "otpVerified": True, "panditId": pid},
           reason="Digital acceptance (OTP verified)", ip=ip, device=device,
           old={"accepted": False}, new={"accepted": True, "version": a.version, "hash": a.document_hash})
    db.add(Notif(user_id=pandit.user_id, channel="In-App",
                 message=f'You accepted agreement "{a.title}" (v{a.version}). A signed copy is in your portal.',
                 ts=int(time.time() * 1000)))
    await db.flush()
    return row


def out_acceptance(r) -> dict:
    return {"id": r.id, "agreementId": r.agreement_id, "panditId": r.pandit_id, "method": r.method,
            "otpVerified": bool(r.otp_verified), "ip": r.ip, "device": r.device,
            "acceptedAt": r.accepted_at, "signatureRef": r.signature_ref or None}


async def for_pandit(db, pid: str) -> dict:
    cur = await current(db)
    rows = (await db.execute(
        select(AgreementAcceptance, Agreement.version, Agreement.title, Agreement.document_hash)
        .join(Agreement, Agreement.id == AgreementAcceptance.agreement_id)
        .where(AgreementAcceptance.pandit_id == pid)
        .order_by(AgreementAcceptance.accepted_at.desc()))).all()
    my = []
    for aa, version, title, dh in rows:
        d = out_acceptance(aa)
        d.update({"version": version, "title": title, "documentHash": dh})
        my.append(d)
    return {"current": out(cur) if cur else None, "myAcceptances": my}


async def acceptance_list(db, agreement_id: str) -> list[dict]:
    rows = (await db.execute(
        select(AgreementAcceptance, Pandit.name)
        .outerjoin(Pandit, Pandit.id == AgreementAcceptance.pandit_id)
        .where(AgreementAcceptance.agreement_id == agreement_id)
        .order_by(AgreementAcceptance.accepted_at.desc()))).all()
    return [out_acceptance(aa) | {"panditName": name or None} for aa, name in rows]


async def list_all(db) -> list[dict]:
    rows = (await db.execute(select(Agreement).order_by(
        Agreement.version.desc(), Agreement.created_at.desc()))).scalars().all()
    out_rows = []
    for r in rows:
        r.acceptance_count = len((await db.execute(select(AgreementAcceptance.id).where(
            AgreementAcceptance.agreement_id == r.id))).scalars().all())
        out_rows.append(out(r))
    return out_rows


async def current_out(db) -> dict | None:
    """current() as a plain dict (the ORM instance is not needed at the edge)."""
    row = await current(db)
    return out(row) if row else None
