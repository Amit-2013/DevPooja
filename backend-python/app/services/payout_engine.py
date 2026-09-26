"""Centralized payout calculation engine (Phases 7-8) — twin of
server/services/payoutEngine.js. Single source of truth for payout math and
status vocabulary on the Python side:

  - booking completion (services/bookings.py) calls create_for_booking();
  - admin finance transitions (routers/admin.py) go through transition();
  - commission comes ONLY from the admin-configurable 'commission' setting —
    never hard-coded at call sites.

Status vocabulary (canonical):
  PENDING -> ON_HOLD -> PROCESSING -> DISBURSED
                              |-> FAILED -> REVERSED
Legacy rows ('Pending'/'Paid') are translated by legacy_status().
"""
import json
import time

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import AuditLog, Booking, Pandit, Payout, Setting
from ..util import bad, conflict, not_found

DEFAULT_HOLDS = [
    {"reason": "KYC Pending", "check": "pandit_kyc"},
    {"reason": "Bank Verification Pending", "check": "bank"},
    {"reason": "Customer Dispute", "check": "dispute"},
    {"reason": "Booking Under Review", "check": "review"},
    {"reason": "Refund Pending", "check": "refund"},
    {"reason": "Payment Reconciliation", "check": "reconciliation"},
    {"reason": "Admin Hold", "check": "admin"},
]

STATUSES = ("PENDING", "ON_HOLD", "PROCESSING", "DISBURSED", "FAILED", "REVERSED")
HOLDABLE = {"PENDING", "ON_HOLD", "PROCESSING"}


def legacy_status(s: str | None) -> str | None:
    if s in ("Pending", "pending"):
        return "PENDING"
    if s in ("Paid", "paid"):
        return "DISBURSED"
    return s


def _js_round(x: float) -> int:
    """Node Math.round parity (banker's rounding would diverge)."""
    import math

    return math.floor(x + 0.5) if x >= 0 else math.ceil(x - 0.5)


async def payout_rules(db: AsyncSession) -> list[dict]:
    row = (await db.execute(select(Setting).where(Setting.key == "payout_holds"))).scalar_one_or_none()
    if row and row.value:
        try:
            holds = json.loads(row.value)
            if isinstance(holds, list):
                return holds
        except (ValueError, TypeError):
            pass
    return DEFAULT_HOLDS


async def _audit(db: AsyncSession, actor_user_id: str | None, action: str, entity: str,
                 entity_id: str | None, detail: dict, reason: str | None = None,
                 old_value=None, new_value=None) -> None:
    db.add(AuditLog(
        actor_user_id=actor_user_id, actor_role="admin" if actor_user_id else "system",
        action=action, entity=entity, entity_id=entity_id,
        detail=json.dumps(detail),
        old_value=json.dumps(old_value) if old_value is not None else None,
        new_value=json.dumps(new_value) if new_value is not None else None,
        reason=(reason or None) and str(reason)[:300],
        created_at=int(time.time() * 1000)))


def calculate(gross, commission_pct, tax_amt=0, refund_amt=0, adjustment_amt=0) -> dict:
    """net = gross - commission - tax - refund - adjustments (all rounded)."""
    gross_amt = _js_round(gross or 0)
    commission = _js_round((gross_amt * (commission_pct or 0)) / 100)
    return {
        "gross_amount": gross_amt,
        "commission_amt": commission,
        "tax_amt": _js_round(tax_amt or 0),
        "refund_amt": _js_round(refund_amt or 0),
        "adjustment_amt": _js_round(adjustment_amt or 0),
        "net": gross_amt - commission - _js_round(tax_amt or 0) - _js_round(refund_amt or 0)
               - _js_round(adjustment_amt or 0),
    }


async def _get_setting_int(db: AsyncSession, key: str, default: int) -> int:
    row = (await db.execute(select(Setting).where(Setting.key == key))).scalar_one_or_none()
    if row and row.value:
        try:
            return int(json.loads(row.value))
        except (ValueError, TypeError):
            return default
    return default


async def create_for_booking(db: AsyncSession, row, pandit_id: str | None) -> str:
    """One PENDING payout per booking completion. Commission from the 'commission'
    setting; a payout for an unverified pandit is auto-held with a visible reason."""
    q = json.loads(row.q or "{}") if row.q else {}
    pct = await _get_setting_int(db, "commission", 20)
    calc = calculate(q.get("svc") or 0, pct)
    n = (await db.execute(select(func.count()).select_from(Payout))).scalar_one() + 1
    pid = f"PO{n}-{row.id}"
    db.add(Payout(id=pid, pandit_id=pandit_id, amount=calc["net"], date=_today(),
                  status="PENDING", booking_id=row.id,
                  gross_amount=calc["gross_amount"], commission_amt=calc["commission_amt"],
                  tax_amt=calc["tax_amt"], refund_amt=calc["refund_amt"],
                  adjustment_amt=calc["adjustment_amt"], currency="INR"))
    await db.flush()
    # Creation-time hold evaluation (same rules the engine applies on transitions).
    rules = await payout_rules(db)
    if pandit_id:
        pandit = (await db.execute(select(Pandit).where(Pandit.id == pandit_id))).scalar_one_or_none()
        rule = next((h for h in rules if h.get("check") == "pandit_kyc"), None)
        if rule and pandit and pandit.status != "verified":
            await _apply_hold(db, pid, rule.get("reason") or "KYC Pending", rule.get("note"))
    elif row.booking_id:
        b = (await db.execute(select(Booking).where(Booking.id == row.booking_id))).scalar_one_or_none()
        rule = next((h for h in rules if h.get("check") == "review"), None)
        if rule and b and b.esc:
            await _apply_hold(db, pid, rule.get("reason") or "Booking Under Review", rule.get("note"))
    return pid


def _today() -> str:
    import datetime as _dt

    return _dt.date.today().isoformat()


async def _apply_hold(db: AsyncSession, payout_id: str, reason: str, note: str | None) -> None:
    """Direct hold write used at creation time (no transition validation needed)."""
    row = (await db.execute(select(Payout).where(Payout.id == payout_id))).scalar_one()
    row.status = "ON_HOLD"
    row.hold_reason = (reason or "Admin Hold")[:120]
    row.hold_note = (note or None) and str(note)[:500]
    await db.flush()


async def get_payout(db: AsyncSession, payout_id: str) -> Payout | None:
    return (await db.execute(select(Payout).where(Payout.id == payout_id))).scalar_one_or_none()


async def transition(db: AsyncSession, payout_id: str, action: str, actor_user_id: str | None,
                     *, reason: str | None = None, note: str | None = None,
                     payment_ref: str | None = None, utr: str | None = None) -> Payout:
    """Admin lifecycle transitions — same validation matrix as the Node engine."""
    row = await get_payout(db, payout_id)
    if not row:
        raise not_found("Payout not found")
    src = legacy_status(row.status)

    to: str | None = None
    patch: dict = {}
    if action == "process":
        if src == "ON_HOLD" and not reason:
            raise bad("Lift the hold with a reason before processing")
        if src not in ("PENDING", "ON_HOLD"):
            raise conflict("Cannot process a payout in " + str(src))
        to = "PROCESSING"
        patch = {"processing_date": _today()}
        if reason:
            patch["hold_reason"] = None
            patch["hold_note"] = None
    elif action == "disburse":
        if src != "PROCESSING":
            raise conflict("Only PROCESSING payouts can be disbursed (now " + str(src) + ")")
        if not payment_ref and not utr:
            raise bad("A payment reference or UTR is required to disburse")
        to = "DISBURSED"
        patch = {"disbursement_date": _today(), "payment_ref": payment_ref, "utr": utr}
    elif action == "hold":
        if src not in HOLDABLE:
            raise conflict("Cannot hold a payout in " + str(src))
        if not reason:
            raise bad("A hold reason is required — pandits must see WHY a payout is on hold")
        to = "ON_HOLD"
        patch = {"hold_reason": str(reason)[:120], "hold_note": (str(note)[:500] if note else None)}
    elif action == "fail":
        if src not in ("PENDING", "ON_HOLD", "PROCESSING"):
            raise conflict("Cannot fail a payout in " + str(src))
        if not reason:
            raise bad("A reason is required to mark a payout FAILED")
        to = "FAILED"
        patch = {"hold_reason": None}
    elif action == "reverse":
        if src != "DISBURSED":
            raise conflict("Only DISBURSED payouts can be reversed (now " + str(src) + ")")
        if not reason:
            raise bad("A reason is required to reverse a disbursed payout")
        to = "REVERSED"
    else:
        raise bad("Unknown payout action")

    for k, val in patch.items():
        setattr(row, k, val)
    row.status = to
    detail: dict = {"from": src, "to": to}
    if reason:
        detail["reason"] = str(reason)[:200]
    if note:
        detail["note"] = note
    if payment_ref:
        detail["paymentRef"] = payment_ref
    if utr:
        detail["utr"] = utr
    await _audit(db, actor_user_id, "payout." + action, "payout", payout_id, detail,
                 reason=reason)
    await db.flush()
    return row


async def set_adjustment(db: AsyncSession, payout_id: str, amt: int,
                         actor_user_id: str | None, reason: str | None = None) -> Payout:
    """Adjustment recomputes net against the STORED commission/tax/refund; only
    allowed before the money has left the platform."""
    row = await get_payout(db, payout_id)
    if not row:
        raise not_found("Payout not found")
    src = legacy_status(row.status)
    if src in ("DISBURSED", "REVERSED", "FAILED"):
        raise conflict("Payout is " + str(src) + " — adjustments only apply before disbursement")
    gross = row.gross_amount if row.gross_amount is not None else (row.amount or 0)
    commission = row.commission_amt if row.commission_amt is not None else 0
    calc = calculate(gross, 0, tax_amt=row.tax_amt or 0,
                     refund_amt=row.refund_amt or 0, adjustment_amt=amt or 0)
    net = gross - commission - calc["tax_amt"] - calc["refund_amt"] - calc["adjustment_amt"]
    old_adj = row.adjustment_amt or 0
    row.amount = net
    row.adjustment_amt = calc["adjustment_amt"]
    await _audit(db, actor_user_id, "payout.adjustment", "payout", payout_id,
                 {"from": old_adj, "to": calc["adjustment_amt"], "net": net},
                 reason=reason)
    await db.flush()
    return row
