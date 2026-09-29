'use strict';
/* Phase 14: shared coupon plumbing for every paid surface.
   priceRequest (puja bookings) validates via the pricing engine; kundali
   purchases and cart orders reuse couponProblem from shared/pricing.js for
   identical wording, and all three surfaces record redemptions here at the
   money moment. `used` stays the global counter; coupon_redemptions is what
   per_user counts. */
const { db } = require('../db');
const P = require('../../shared/pricing');

/* Row shape consumed by P.couponProblem — from a coupons row or a plain dict. */
function couponForProblem(c) {
  if (!c) return null;
  return {
    code: c.code, type: c.type, val: c.val, max: c.max, min: c.min,
    active: !!(c.active ?? 1),
    scope: c.scope || 'ALL', pujaId: c.puja_id || c.pujaId || null,
    starts: c.starts || null, expires: c.expires || null, per_user: c.per_user || 0
  };
}

/* How many times this user has already redeemed a code. */
function usedByUser(code, userId) {
  if (!userId) return 0;
  return db.prepare('SELECT COUNT(*) AS n FROM coupon_redemptions WHERE code=? AND user_id=?').get(String(code).toUpperCase(), userId).n;
}

/* Validate a cart-order coupon (ALL scope only): returns { coupon, problem }.
   The coupon's minimum is evaluated against the goods subtotal. */
function checkForOrder(code, userId, subtotal) {
  const row = db.prepare('SELECT * FROM coupons WHERE code=?').get(String(code).toUpperCase());
  const coupon = couponForProblem(row);
  const problem = P.couponProblem(coupon, subtotal || 0, { scope: 'ORDER', usedByUser: usedByUser(code, userId) });
  return { coupon, problem };
}

/* Discount for a cart order (a goods subtotal, no service minimum semantics).
   Flat codes subtract; pct codes take pct of subtotal capped at max. */
function discountForOrder(coupon, subtotal) {
  if (!coupon) return 0;
  const raw = coupon.type === 'pct' ? Math.round(subtotal * coupon.val / 100) : coupon.val;
  return Math.min(raw, coupon.max || raw);
}

/* Record one redemption at the money moment (per-user cap counts these). */
function recordRedemption(code, userId, source, refId, amount) {
  db.prepare('INSERT OR IGNORE INTO coupon_redemptions(code,user_id,source,ref_id,amount,created) VALUES(?,?,?,?,?,?)')
    .run(String(code).toUpperCase(), userId, source, refId, amount || 0, Date.now());
}

module.exports = { couponForProblem, usedByUser, checkForOrder, discountForOrder, recordRedemption };
