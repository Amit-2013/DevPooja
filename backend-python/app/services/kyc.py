"""Per-document KYC management (Phase 4) — twin of server/services/kyc.js.
Activates the kyc_documents table (migration 014 twin). Status vocabulary,
supersede semantics, audited decisions and the expiry sweep match the Node twin."""
import json
import time

from sqlalchemy import select

from ..models import AuditLog, KycDocument, Notif, Pandit
from ..util import bad, conflict, not_found, rid

STATUSES = ["PENDING", "UNDER_REVIEW", "VERIFIED", "REJECTED", "EXPIRED",
            "REVERIFICATION_REQUIRED"]
DOC_TYPES = ["AADHAAR", "PAN", "ADDRESS_PROOF", "PHOTOGRAPH", "QUALIFICATION",
             "TRAINING", "OTHER"]
OPEN_STATUSES = ["PENDING", "UNDER_REVIEW", "REVERIFICATION_REQUIRED"]
REMIND_AHEAD_DAYS = 30

_CLOSE = {"VERIFIED", "REJECTED", "EXPIRED", "SUPERSEDED"}


def _audit(db, uid, action, entity, entity_id, detail, reason=None, old=None, new=None):
    db.add(AuditLog(actor_user_id=uid, actor_role="admin" if uid else "system",
                    action=action, entity=entity, entity_id=entity_id,
                    detail=json.dumps(detail),
                    old_value=json.dumps(old) if old is not None else None,
                    new_value=json.dumps(new) if new is not None else None,
                    reason=reason, created_at=int(time.time() * 1000)))


def out(r) -> dict:
    return {"id": r.id, "panditId": r.pandit_id, "panditName": getattr(r, "pandit_name", None),
            "docType": r.doc_type, "fileName": r.file_name, "status": r.status,
            "uploadedAt": r.uploaded_at, "verifiedBy": r.verified_by,
            "verifiedAt": r.verified_at, "rejectReason": r.reject_reason,
            "expiresAt": r.expires_at, "nextReverificationAt": r.next_reverification_at}


async def for_pandit(db, pid: str) -> list:
    rows = (await db.execute(select(KycDocument).where(KycDocument.pandit_id == pid)
                             .order_by(KycDocument.uploaded_at.desc()))).scalars().all()
    return rows


async def upload(db, *, pid: str, uid: str, doc_type: str, file_name: str,
                 original_name: str = "") -> KycDocument:
    if doc_type not in DOC_TYPES:
        raise bad("Unknown document type")
    if not file_name:
        raise bad("Attach the document file")
    prior = (await db.execute(
        select(KycDocument).where(
            KycDocument.pandit_id == pid, KycDocument.doc_type == doc_type,
            KycDocument.status.in_(OPEN_STATUSES)))).scalars().first()
    if prior:
        prior.status = "SUPERSEDED"
        _audit(db, uid, "kyc.superseded", "kyc_document", prior.id, {"docType": doc_type})
    row = KycDocument(id="kyc" + rid(6), pandit_id=pid, doc_type=doc_type,
                      file_name=file_name, status="PENDING", uploaded_at=int(time.time() * 1000))
    db.add(row)
    await db.flush()
    _audit(db, uid, "kyc.upload", "kyc_document", row.id,
           {"docType": doc_type, "originalName": str(original_name or "")[:120]})
    return row


async def decide(db, *, id: str, uid: str, status: str, reason: str | None = None,
                 expires_at: int | None = None, reverify_at: int | None = None) -> KycDocument:
    row = (await db.execute(select(KycDocument).where(KycDocument.id == id))).scalar_one_or_none()
    if not row:
        raise not_found("KYC document not found")
    if status not in STATUSES:
        raise bad("Unknown KYC status")
    if row.status in _CLOSE and status not in ("REVERIFICATION_REQUIRED", "VERIFIED"):
        raise conflict("Document already " + row.status)
    if status == "REJECTED" and not reason:
        raise bad("A rejection reason is required — the pandit must see WHY")
    if status == "REVERIFICATION_REQUIRED" and not reason:
        raise bad("Say what must be re-uploaded and why")
    old = row.status
    row.status = status
    row.verified_by = uid
    row.verified_at = int(time.time() * 1000)
    row.reject_reason = (str(reason)[:300] if reason and status in ("REJECTED", "REVERIFICATION_REQUIRED") else None)
    row.expires_at = expires_at if status == "VERIFIED" else None
    row.next_reverification_at = reverify_at if status == "VERIFIED" else None
    await db.flush()
    _audit(db, uid, "kyc.decide", "kyc_document", row.id,
           {"docType": row.doc_type, "from": old, "to": status, **({"reason": reason} if reason else {})},
           reason=reason, old={"status": old}, new={"status": status})
    p = (await db.execute(select(Pandit.user_id).where(Pandit.id == row.pandit_id))).scalar_one_or_none()
    if p:
        db.add(Notif(user_id=p, channel="In-App",
                     message=f"Your {row.doc_type} document is {status.lower().replace('_', ' ')}"
                             + (f": {reason}" if reason else ""),
                     ts=int(time.time() * 1000)))
    return row


async def sweep(db) -> int:
    """Flip VERIFIED docs past expiry to EXPIRED; notify. Idempotent."""
    now = int(time.time() * 1000)
    stale = (await db.execute(select(KycDocument).where(
        KycDocument.status == "VERIFIED",
        KycDocument.expires_at.is_not(None), KycDocument.expires_at < now))).scalars().all()
    for row in stale:
        row.status = "EXPIRED"
        _audit(db, None, "kyc.auto_expire", "kyc_document", row.id,
               {"docType": row.doc_type, "panditId": row.pandit_id})
        p = (await db.execute(select(Pandit.user_id).where(Pandit.id == row.pandit_id))).scalar_one_or_none()
        if p:
            db.add(Notif(user_id=p, channel="In-App",
                         message=f"Your {row.doc_type} document has expired. Please upload a fresh copy.",
                         ts=int(time.time() * 1000)))
    return len(stale)


async def summary(db) -> dict:
    await sweep(db)
    ahead = int(time.time() * 1000) + REMIND_AHEAD_DAYS * 86400000
    rows = (await db.execute(
        select(KycDocument, Pandit).outerjoin(Pandit, Pandit.id == KycDocument.pandit_id)
        .order_by(KycDocument.uploaded_at.desc()).limit(500))).all()
    docs = []
    for k, p in rows:
        k.pandit_name = p.name if p else None
        docs.append(out(k))
    reminders = [d for d in docs
                 if d["status"] in ("EXPIRED", "REVERIFICATION_REQUIRED")
                 or (d["status"] == "VERIFIED" and ((d["expiresAt"] and d["expiresAt"] < ahead)
                                                     or (d["nextReverificationAt"] and d["nextReverificationAt"] < ahead)))]
    counts = {s: sum(1 for d in docs if d["status"] == s) for s in STATUSES}
    return {"docs": docs, "reminders": reminders, "counts": counts,
            "STATUSES": STATUSES, "DOC_TYPES": DOC_TYPES}
