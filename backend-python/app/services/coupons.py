"""Phase 14: shared coupon plumbing for every paid surface.

price_request (puja bookings) validates via the pricing engine; kundali
purchases and cart orders reuse coupon_problem from ..pricing for identical
wording, and all three surfaces record redemptions here at the money moment.
`used` stays the global counter; coupon_redemptions is what per_user counts.
"""
import time

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Coupon, CouponRedemption
from ..pricing import coupon_problem


def coupon_for_problem(c: Coupon | None) -> dict | None:
    """Row shape consumed by coupon_problem — from a Coupon model or a dict."""
    if c is None:
        return None
    return {
        "code": c.code, "type": c.type, "val": c.val, "max": c.max, "min": c.min,
        "active": bool(c.active),
        "scope": c.scope or "ALL", "pujaId": c.puja_id or None,
        "starts": c.starts or None, "expires": c.expires or None,
        "per_user": c.per_user or 0,
    }


async def used_by_user(db: AsyncSession, code: str, user_id: str | None) -> int:
    """How many times this user has already redeemed a code."""
    if not user_id:
        return 0
    n = (await db.execute(select(func.count()).select_from(CouponRedemption).where(
        CouponRedemption.code == str(code).upper(), CouponRedemption.user_id == user_id
    ))).scalar_one()
    return int(n)


async def check_for_order(db: AsyncSession, code: str, user_id: str, subtotal: int = 0) -> tuple[dict | None, str]:
    """Validate a cart-order coupon (ALL scope only): (coupon, problem).
    The coupon's minimum is evaluated against the goods subtotal."""
    row = (await db.execute(select(Coupon).where(
        Coupon.code == str(code).upper()))).scalar_one_or_none()
    coupon = coupon_for_problem(row)
    problem = coupon_problem(coupon, subtotal or 0, {"scope": "ORDER", "usedByUser": await used_by_user(db, code, user_id)})
    return coupon, problem


def discount_for_order(coupon: dict | None, subtotal: int) -> int:
    """Discount for a cart order (a goods subtotal, no service minimum
    semantics). Flat codes subtract; pct codes take pct of subtotal, capped."""
    if not coupon:
        return 0
    raw = round(subtotal * coupon["val"] / 100) if coupon["type"] == "pct" else coupon["val"]
    return min(raw, coupon["max"] or raw)


async def record_redemption(db: AsyncSession, code: str, user_id: str,
                            source: str, ref_id: str, amount: int = 0) -> None:
    """Record one redemption at the money moment (per-user cap counts these)."""
    db.add(CouponRedemption(code=str(code).upper(), user_id=user_id, source=source,
                            ref_id=ref_id, amount=amount or 0,
                            created=int(time.time() * 1000)))
    await db.flush()
