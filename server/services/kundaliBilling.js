/* Kundali commercial model.

   One customer account includes a plan-wise number of free (personal) kundalis;
   every additional — and every FAMILY MEMBER — kundali is a chargeable request.
   All prices, GST, discounts, coupon eligibility and free counts come from the
   `kundali_pricing` setting (Admin > Kundali Management > Pricing). Nothing is
   hard-coded here beyond safe defaults for a fresh database.

   Billing states: FREE | PENDING_PAYMENT | PAID | REFUNDED | CANCELLED */
'use strict';
const { db, getSetting } = require('../db');
const { bad, conflict } = require('../lib/util');
const DEFAULTS = {
  active: true,
  currency: 'INR',
  personalPrice: 0,        // paid only after the plan's free quota is used up
  familyPrice: 499,        // every family-member kundali is chargeable
  additionalPrice: 499,    // extra personal kundalis beyond the quota
  gstPct: 5,
  discountPct: 0,
  couponEligible: true,
  freeCounts: { customer: 1, plus: 2, premium: 5 }
};

const pricing = () => Object.assign({}, DEFAULTS, getSetting('kundali_pricing', {}));

const includedCount = (user) => {
  const p = pricing();
  if (user.premium) return p.freeCounts.premium;
  if (user.plus) return p.freeCounts.plus;
  return p.freeCounts.customer;
};

/* Personal kundalis used against the plan quota (family kundalis never consume it). */
const usedCount = (userId) =>
  db.prepare("SELECT COUNT(*) n FROM kundalis WHERE customer_id=? AND (relationship='' OR relationship IS NULL)").get(userId).n;

/* Decide billing for a request. `relationship` empty => personal kundali. */
function classify(user, relationship) {
  const p = pricing();
  if (!p.active) throw bad('Kundali generation is currently unavailable');
  const rel = String(relationship || '').trim();
  if (rel) return { family: true, included: false, base: p.familyPrice, label: rel };
  const used = usedCount(user.id), inc = includedCount(user);
  if (used < inc) return { family: false, included: true, base: 0, label: 'Included' };
  return { family: false, included: false, base: p.additionalPrice, label: 'Additional' };
}

/* Full quote: base -> plan/special discount -> coupon -> GST. Amounts in rupees (int). */
function quoteFor(user, { relationship, coupon } = {}) {
  const p = pricing();
  const c = classify(user, relationship);
  let discount = Math.round(c.base * (p.discountPct || 0) / 100);
  let couponInfo = null;
  if (coupon && c.base > 0) {
    if (!p.couponEligible) throw bad('Coupons do not apply to kundali purchases');
    const cp = db.prepare('SELECT * FROM coupons WHERE code=? AND active=1').get(String(coupon).toUpperCase());
    if (!cp) throw bad('Coupon code is not valid');
    if (cp.min && c.base < cp.min) throw bad('Coupon requires a minimum amount of Rs ' + cp.min);
    const raw = cp.type === 'pct' ? Math.round((c.base - discount) * cp.val / 100) : cp.val;
    discount += Math.min(raw, cp.max || raw);
    couponInfo = cp.code;
  }
  const taxable = Math.max(0, c.base - discount);
  const gst = Math.round(taxable * (p.gstPct || 0) / 100);
  return {
    family: c.family, included: c.included, label: c.label,
    base: c.base, discount, gst, final: taxable + gst,
    currency: p.currency, coupon: couponInfo, gstPct: p.gstPct || 0
  };
}

/* Idempotency: returns the previously stored result for a key within its scope. */
function idemGet(key, scope) {
  if (!key) return null;
  const r = db.prepare('SELECT result FROM idempotency_keys WHERE key=? AND scope=?').get(String(key).slice(0, 120), scope);
  return r ? JSON.parse(r.result) : null;
}
function idemPut(key, scope, result) {
  if (!key) return;
  db.prepare('INSERT OR IGNORE INTO idempotency_keys(key,scope,result,created_at) VALUES(?,?,?,?)')
    .run(String(key).slice(0, 120), scope, JSON.stringify(result), Date.now());
}

const BILLING_STATES = ['FREE', 'PENDING_PAYMENT', 'PAID', 'REFUNDED', 'CANCELLED'];

module.exports = { pricing, includedCount, usedCount, classify, quoteFor, idemGet, idemPut, BILLING_STATES, DEFAULTS };
