"""Typed money ledger (master plan Phase 10) + the effective-dated commission
tier resolver (Phase 9) — async twin of server/services/ledger.js, activating
the migration-014 `transactions` and `commission_tiers` tables.

Types and sign convention (platform perspective):
  SERVICE_PAYMENT / KUNDALI_PAYMENT / DAKSHINA / COMMISSION  inflows (+)
  REFUND / PAYOUT                                            outflows (-)
Dedupe contract: one row per (type, ref_table, ref_id) so payment retries and
transition replays never double-count. Commission tiers resolve by active
window + category (exact before ALL, newest effective_from first); the
'commission' setting stays the fallback when no tier matches.
"""
import json
import time

from sqlalchemy import select, update

from ..db import SessionLocal  # noqa: F401
from ..models import AuditLog, CommissionTier, Transaction
from ..util import bad

TYPES = ["SERVICE_PAYMENT", "KUNDALI_PAYMENT", "DAKSHINA", "REFUND", "COMMISSION", "PAYOUT"]


def out(r: Transaction, user_name: str | None = None, pandit_name: str | None = None) -> dict:
    return {"id": r.id, "type": r.type, "amount": r.amount, "userId": r.user_id,
            "userName": user_name, "panditId": r.pandit_id, "panditName": pandit_name,
            "bookingId": r.booking_id, "kundaliId": r.kundali_id, "refTable": r.ref_table,
            "refId": r.ref_id, "note": r.note or "", "createdAt": r.created_at}


async def record(db, *, type: str, amount: int, user_id: str | None = None,
                 pandit_id: str | None = None, booking_id: str | None = None,
                 kundali_id: str | None = None, ref_table: str | None = None,
                 ref_id: str | None = None, note: str | None = None) -> int:
    if type not in TYPES:
        raise bad("Unknown ledger type: " + str(type))
    amt = round(amount or 0)
    if not amt:
        raise bad("Ledger amount must be non-zero")
    row = Transaction(type=type, user_id=user_id, pandit_id=pandit_id, booking_id=booking_id,
                      kundali_id=kundali_id, amount=amt, currency="INR",
                      ref_table=ref_table, ref_id=ref_id,
                      note=(note or None) and str(note)[:200],
                      created_at=int(time.time() * 1000))
    db.add(row)
    await db.flush()
    return row.id


async def dedupe(db, *, type: str, amount: int, user_id: str | None = None,
                 pandit_id: str | None = None, booking_id: str | None = None,
                 kundali_id: str | None = None, ref_table: str | None = None,
                 ref_id: str | None = None, note: str | None = None) -> dict:
    hit = (await db.execute(select(Transaction.id).where(
        Transaction.type == type, Transaction.ref_table == ref_table,
        Transaction.ref_id == ref_id).limit(1))).scalars().first()
    if hit:
        return {"id": hit, "deduped": True}
    new_id = await record(db, type=type, amount=amount, user_id=user_id, pandit_id=pandit_id,
                          booking_id=booking_id, kundali_id=kundali_id,
                          ref_table=ref_table, ref_id=ref_id, note=note)
    return {"id": new_id, "deduped": False}


async def list_entries(db, *, type: str | None = None, pandit_id: str | None = None,
                       from_ts: int | None = None, to_ts: int | None = None,
                       limit: int = 200) -> list[dict]:
    from ..models import Pandit, User
    q = (select(Transaction, User.name, Pandit.name)
         .join(User, User.id == Transaction.user_id, isouter=True)
         .join(Pandit, Pandit.id == Transaction.pandit_id, isouter=True))
    conds = []
    if type in TYPES:
        conds.append(Transaction.type == type)
    if pandit_id:
        conds.append(Transaction.pandit_id == pandit_id)
    if from_ts:
        conds.append(Transaction.created_at >= int(from_ts))
    if to_ts:
        conds.append(Transaction.created_at <= int(to_ts))
    if conds:
        q = q.where(*conds)
    q = q.order_by(Transaction.created_at.desc(), Transaction.id.desc()).limit(min(500, max(1, int(limit))))
    rows = (await db.execute(q)).all()
    return [out(t, un, pn) for t, un, pn in rows]


async def totals(db, *, from_ts: int | None = None, to_ts: int | None = None) -> dict:
    from sqlalchemy import func
    q = select(Transaction.type, func.sum(Transaction.amount), func.count()).group_by(Transaction.type)
    conds = []
    if from_ts:
        conds.append(Transaction.created_at >= int(from_ts))
    if to_ts:
        conds.append(Transaction.created_at <= int(to_ts))
    if conds:
        q = q.where(*conds)
    rows = (await db.execute(q)).all()
    by_type: dict = {}
    for t, total, n in rows:
        by_type[t] = {"total": int(total or 0), "count": n}
    by_type["_inflow"] = sum(v["total"] for k, v in by_type.items() if not k.startswith("_") and v["total"] > 0)
    by_type["_outflow"] = sum(v["total"] for k, v in by_type.items() if not k.startswith("_") and v["total"] < 0)
    return by_type


# ---------------- Phase 9: effective-dated commission tiers ----------------

def tier_out(r: CommissionTier) -> dict:
    return {"id": r.id, "tier": r.tier, "serviceCategory": r.service_category,
            "commissionPct": r.commission_pct, "panditSharePct": r.pandit_share_pct,
            "effectiveFrom": r.effective_from, "effectiveTo": r.effective_to,
            "active": bool(r.active)}


async def tier_list(db) -> list[dict]:
    rows = (await db.execute(select(CommissionTier)
                             .order_by(CommissionTier.service_category,
                                       CommissionTier.effective_from.desc(),
                                       CommissionTier.id.desc()))).scalars().all()
    return [tier_out(r) for r in rows]


async def resolve_tier(db, pandit_id: str | None, service_category: str | None,
                       on: str | None) -> dict | None:
    """Active tier covering `on` (ISO date), exact category before ALL, newest
    effective_from first. Returns None = use the settings fallback."""
    date = on or time.strftime("%Y-%m-%d")
    cat = service_category or "ALL"
    rows = (await db.execute(select(CommissionTier).where(
        CommissionTier.active == 1,
        (CommissionTier.effective_from.is_(None)) | (CommissionTier.effective_from <= date),
        (CommissionTier.effective_to.is_(None)) | (CommissionTier.effective_to >= date),
        CommissionTier.service_category.in_([cat, "ALL"]),
    ).order_by(
        # exact category first, then newest effective_from (SQLAlchemy case())
        __import__("sqlalchemy").case((CommissionTier.service_category == cat, 0), else_=1),
        CommissionTier.effective_from.desc(), CommissionTier.id.desc()))).scalars().all()
    return tier_out(rows[0]) if rows else None


async def commission_pct(db, *, pandit_id: str | None, service_category: str | None) -> dict:
    tier = await resolve_tier(db, pandit_id, service_category, None)
    if tier:
        return {"pct": tier["commissionPct"], "tier": tier["tier"], "tierId": tier["id"]}
    from ..config import get_settings
    # Node parity: settings knob 'commission' with the same 20 default.
    from ..models import Setting
    row = (await db.execute(select(Setting).where(Setting.key == "commission"))).scalar_one_or_none()
    try:
        pct = json.loads(row.value) if row else 20
    except (TypeError, ValueError):
        pct = 20
    return {"pct": pct, "tier": None, "tierId": None}


async def tier_create(db, actor: str, body: dict) -> dict:
    b = body or {}
    tier = str(b.get("tier") or "").strip()
    if not tier:
        raise bad("Tier name is required")
    try:
        pct = float(b.get("commissionPct"))
    except (TypeError, ValueError):
        raise bad("Commission % must be 0..90")
    if not 0 <= pct <= 90:
        raise bad("Commission % must be 0..90")
    try:
        share = float(b.get("panditSharePct") or 0)
    except (TypeError, ValueError):
        raise bad("Pandit share % must be 0..100")
    if not 0 <= share <= 100:
        raise bad("Pandit share % must be 0..100")
    if pct + share > 100:
        raise bad("Commission + pandit share cannot exceed 100%")
    row = CommissionTier(tier=tier[:40], service_category=b.get("serviceCategory") or "ALL",
                         commission_pct=round(pct), pandit_share_pct=round(share),
                         effective_from=b.get("effectiveFrom"), effective_to=b.get("effectiveTo"),
                         active=0 if b.get("active") is False else 1)
    db.add(row)
    await db.flush()
    db.add(AuditLog(actor_user_id=actor, actor_role="admin", action="commission.tier_created",
                    entity="commission_tier", entity_id=str(row.id),
                    detail=json.dumps({"tier": tier, "serviceCategory": row.service_category,
                                       "commissionPct": row.commission_pct,
                                       "effectiveFrom": row.effective_from}),
                    new_value=json.dumps({"tier": tier, "commissionPct": row.commission_pct}),
                    created_at=int(time.time() * 1000)))
    return tier_out(row)


async def tier_update(db, actor: str, id_: int, body: dict) -> dict:
    row = (await db.execute(select(CommissionTier).where(CommissionTier.id == id_))).scalar_one_or_none()
    if not row:
        raise bad("Tier not found")
    b = body or {}
    old = {"pct": row.commission_pct, "active": bool(row.active)}
    if "tier" in b:
        row.tier = str(b["tier"])[:40]
    if "serviceCategory" in b:
        row.service_category = b["serviceCategory"]
    if "commissionPct" in b:
        row.commission_pct = round(float(b["commissionPct"]))
    if "panditSharePct" in b:
        row.pandit_share_pct = round(float(b["panditSharePct"]))
    if "effectiveFrom" in b:
        row.effective_from = b["effectiveFrom"]
    if "effectiveTo" in b:
        row.effective_to = b["effectiveTo"]
    if "active" in b:
        row.active = 1 if b["active"] else 0
    if not 0 <= row.commission_pct <= 90:
        raise bad("Commission % must be 0..90")
    if row.commission_pct + row.pandit_share_pct > 100:
        raise bad("Commission + pandit share cannot exceed 100%")
    await db.flush()
    new = {"pct": row.commission_pct, "active": bool(row.active)}
    db.add(AuditLog(actor_user_id=actor, actor_role="admin", action="commission.tier_updated",
                    entity="commission_tier", entity_id=str(id_),
                    detail=json.dumps({"from": old, "to": new}),
                    old_value=json.dumps(old), new_value=json.dumps(new),
                    created_at=int(time.time() * 1000)))
    return tier_out(row)
