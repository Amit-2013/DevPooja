"""Pandit account status lifecycle (Phase 22) — twin of
server/services/accountStatus.js. ACTIVE == pandit.status 'verified';
onboarding states ('pending'/'rejected') are not lifecycle states. Suspension
and termination block login (users.status), take the pandit off allocation
(avail=0) and hold open payouts with the documented reason; every transition
is audited with old/new lifecycle."""
import json
import time

from sqlalchemy import select

from ..models import AuditLog, Pandit, Payout, User
from ..util import bad, conflict, not_found
from .payout_engine import transition as payout_transition

LIFECYCLE = ["ACTIVE", "UNDER_REVIEW", "SUSPENDED", "TERMINATED"]
REASONS = ["KYC Issue", "Fraud Concern", "Safety Concern", "Serious Complaint",
           "Repeated Cancellation", "Policy Violation", "Other Documented Reason"]

TERMINATED_MARK = "__terminated__"


def _audit(db, uid, action, entity, entity_id, detail, reason=None, old=None, new=None):
    db.add(AuditLog(actor_user_id=uid, actor_role="admin" if uid else "system",
                    action=action, entity=entity, entity_id=entity_id,
                    detail=json.dumps(detail),
                    old_value=json.dumps(old) if old is not None else None,
                    new_value=json.dumps(new) if new is not None else None,
                    reason=reason, created_at=int(time.time() * 1000)))


def _targets(lc: str) -> dict:
    if lc == "ACTIVE":
        return {"pstatus": "verified", "ustatus": "active", "avail": 1}
    if lc == "UNDER_REVIEW":
        return {"pstatus": "verified", "ustatus": "active", "avail": 1}
    if lc == "SUSPENDED":
        return {"pstatus": "verified", "ustatus": "suspended", "avail": 0}
    return {"pstatus": "verified", "ustatus": "disabled", "avail": 0}  # TERMINATED


def current_lifecycle(p: Pandit) -> str | None:
    if p.status != "verified":
        return None
    if p.account_reason and p.account_note == TERMINATED_MARK:
        return "TERMINATED"
    if p.account_reason or not p.avail:
        return "SUSPENDED"
    return "ACTIVE"


async def transition(db, pid: str, lc: str, actor_uid: str | None, *, reason: str | None = None,
                     note: str | None = None, frm: str | None = None, to: str | None = None,
                     review_date: str | None = None) -> Pandit:
    p = await db.get(Pandit, pid)
    if not p:
        raise not_found("Pandit not found")
    if lc not in LIFECYCLE:
        raise bad("Unknown lifecycle status")
    if reason not in REASONS and lc not in ("ACTIVE", "UNDER_REVIEW"):
        raise bad("A documented reason is required")
    was = current_lifecycle(p)
    if was == "TERMINATED" and lc != "TERMINATED":
        raise conflict("A terminated pandit account cannot be reinstated")
    if was == lc:
        raise conflict("Pandit is already " + lc)
    t = _targets(lc)
    u = (await db.execute(select(User).where(User.id == p.user_id))).scalar_one_or_none()

    p.status = t["pstatus"]
    p.avail = t["avail"]
    p.account_reason = None if lc == "ACTIVE" else (reason or None)
    p.account_from = None if lc == "ACTIVE" else (frm or time.strftime("%Y-%m-%d"))
    p.account_to = None if lc == "ACTIVE" else (to or None)
    p.account_review_date = None if lc == "ACTIVE" else (review_date or None)
    p.account_note = TERMINATED_MARK if lc == "TERMINATED" else (note or None)
    if u and t["ustatus"] and u.status != t["ustatus"]:
        audit_detail = {"from": u.status or "active", "to": t["ustatus"], "panditLifecycle": lc}
        u.status = t["ustatus"]
        _audit(db, actor_uid, "account.status", "user", u.id, audit_detail,
               reason=reason, old={"status": u.status or "active"}, new={"status": t["ustatus"]})
    await db.flush()

    # Payout linkage: hold open payouts on suspension/termination; release on reinstatement.
    rows = (await db.execute(select(Payout).where(
        Payout.pandit_id == pid,
        Payout.status.in_(["PENDING", "ON_HOLD", "PROCESSING"])))).scalars().all()
    for po in rows:
        try:
            if lc in ("SUSPENDED", "TERMINATED"):
                await payout_transition(db, po.id, "hold", actor_uid,
                                        reason="Admin Hold", note=f"Pandit {lc}: {reason}")
            elif lc == "ACTIVE":
                await payout_transition(db, po.id, "process", actor_uid,
                                        reason="Pandit reinstated")
        except Exception:
            pass  # already held / not holdable — mirror of the Node twin

    _audit(db, actor_uid, "pandit.lifecycle", "pandit", pid,
           {"from": was or p.status, "to": lc, **({"reason": reason} if reason else {}),
            **({"reviewDate": review_date} if review_date else {})},
           reason=reason, old={"lifecycle": was or p.status}, new={"lifecycle": lc})
    await db.flush()
    return p


async def overview(db) -> list[dict]:
    rows = (await db.execute(select(Pandit).order_by(Pandit.name))).scalars().all()
    out = []
    for p in rows:
        lc = current_lifecycle(p)
        open_p = (await db.execute(select(Payout.id).where(
            Payout.pandit_id == p.id,
            Payout.status.in_(["PENDING", "ON_HOLD", "PROCESSING"])))).scalars().all()
        out.append({"id": p.id, "name": p.name, "city": p.city, "status": p.status,
                    "lifecycle": lc, "reason": p.account_reason, "from": p.account_from,
                    "to": p.account_to, "reviewDate": p.account_review_date,
                    "note": None if p.account_note == TERMINATED_MARK else p.account_note,
                    "openPayouts": len(open_p)})
    return out
