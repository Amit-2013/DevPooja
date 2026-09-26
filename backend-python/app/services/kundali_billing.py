"""Kundali commercial model — port of server/services/kundaliBilling.js.

One customer account includes a plan-wise number of free (personal) kundalis;
every additional — and every FAMILY MEMBER — kundali is a chargeable request.
All prices, GST, discounts, coupon eligibility and free counts come from the
`kundali_pricing` setting (Admin > Kundali Management > Pricing). Nothing is
hard-coded here beyond safe defaults for a fresh database.

Billing states: FREE | PENDING_PAYMENT | PAID | REFUNDED | CANCELLED"""
import json

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Coupon, Kundali, Setting, User
from ..util import bad

DEFAULTS = {
    "active": True,
    "currency": "INR",
    "personalPrice": 0,        # paid only after the plan's free quota is used up
    "familyPrice": 499,        # every family-member kundali is chargeable
    "additionalPrice": 499,    # extra personal kundalis beyond the quota
    "gstPct": 5,
    "discountPct": 0,
    "couponEligible": True,
    "freeCounts": {"customer": 1, "plus": 2, "premium": 5},
}


async def _get_setting_raw(db: AsyncSession, key: str):
    row = (await db.execute(select(Setting).where(Setting.key == key))).scalar_one_or_none()
    if not row or not row.value:
        return None
    try:
        return json.loads(row.value)
    except (ValueError, TypeError):
        return None


async def pricing(db: AsyncSession) -> dict:
    stored = await _get_setting_raw(db, "kundali_pricing")
    p = dict(DEFAULTS)
    if isinstance(stored, dict):
        p.update(stored)
    return p


async def included_count(db: AsyncSession, user: User) -> int:
    p = await pricing(db)
    if getattr(user, "premium", 0):
        return p["freeCounts"]["premium"]
    if user.plus:
        return p["freeCounts"]["plus"]
    return p["freeCounts"]["customer"]


# Personal kundalis used against the plan quota (family kundalis never consume it).
async def used_count(db: AsyncSession, user_id: str) -> int:
    n = (await db.execute(
        select(func.count()).select_from(Kundali).where(
            Kundali.customer_id == user_id,
            func.coalesce(Kundali.relationship, "") == "",
        ))).scalar_one()
    return int(n)


# Decide billing for a request. `relationship` empty => personal kundali.
async def classify(db: AsyncSession, user: User, relationship: str | None) -> dict:
    p = await pricing(db)
    if not p["active"]:
        raise bad("Kundali generation is currently unavailable")
    rel = str(relationship or "").strip()
    if rel:
        return {"family": True, "included": False, "base": p["familyPrice"], "label": rel}
    used = await used_count(db, user.id)
    inc = await included_count(db, user)
    if used < inc:
        return {"family": False, "included": True, "base": 0, "label": "Included"}
    return {"family": False, "included": False, "base": p["additionalPrice"], "label": "Additional"}


# Full quote: base -> plan/special discount -> coupon -> GST. Amounts in rupees (int).
async def quote_for(db: AsyncSession, user: User, relationship: str | None = None,
                    coupon: str | None = None) -> dict:
    p = await pricing(db)
    c = await classify(db, user, relationship)
    discount = round(c["base"] * (p.get("discountPct") or 0) / 100)
    coupon_info = None
    if coupon and c["base"] > 0:
        if not p.get("couponEligible"):
            raise bad("Coupons do not apply to kundali purchases")
        cp = (await db.execute(select(Coupon).where(
            Coupon.code == str(coupon).upper(), Coupon.active == 1))).scalar_one_or_none()
        if not cp:
            raise bad("Coupon code is not valid")
        if cp.min and c["base"] < cp.min:
            raise bad("Coupon requires a minimum amount of Rs " + str(cp.min))
        raw = round((c["base"] - discount) * cp.val / 100) if cp.type == "pct" else cp.val
        discount += min(raw, cp.max if cp.max else raw)
        coupon_info = cp.code
    taxable = max(0, c["base"] - discount)
    gst = round(taxable * (p.get("gstPct") or 0) / 100)
    return {
        "family": c["family"], "included": c["included"], "label": c["label"],
        "base": c["base"], "discount": discount, "gst": gst, "final": taxable + gst,
        "currency": p["currency"], "coupon": coupon_info, "gstPct": p.get("gstPct") or 0,
    }


# Idempotency: returns the previously stored result for a key within its scope.
async def idem_get(db: AsyncSession, key: str | None, scope: str):
    if not key:
        return None
    from ..models import IdempotencyKey
    r = (await db.execute(select(IdempotencyKey).where(
        IdempotencyKey.key == str(key)[:120], IdempotencyKey.scope == scope))).scalar_one_or_none()
    try:
        return json.loads(r.result) if r and r.result else None
    except (ValueError, TypeError):
        return None


async def idem_put(db: AsyncSession, key: str | None, scope: str, result) -> None:
    if not key:
        return
    from ..models import IdempotencyKey
    exists = (await db.execute(select(IdempotencyKey).where(
        IdempotencyKey.key == str(key)[:120], IdempotencyKey.scope == scope))).scalar_one_or_none()
    if exists:
        return
    db.add(IdempotencyKey(key=str(key)[:120], scope=scope,
                          result=json.dumps(result), created_at=int(now_ms())))


def now_ms() -> int:
    import time
    return int(time.time() * 1000)


BILLING_STATES = ['FREE', 'PENDING_PAYMENT', 'PAID', 'REFUNDED', 'CANCELLED']
