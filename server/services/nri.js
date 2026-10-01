/* NRI packages (master plan Phase 13) — fixed-price puja packages sold to the
   diaspora in their own currency (USD default; `inr_equiv` feeds the INR
   ledger and the rupee display). Commercial pattern mirrors kundali billing:
   quote from the catalogue row, idempotent checkout through the existing
   idempotency_keys store, exactly one ledger row per order (NRI_PAYMENT via
   ledger.dedupe, amount = inr_equiv so reports stay in one currency).

   Statuses: PENDING_PAYMENT -> PAID (mock mode marks PAID immediately, exactly
   like kundali mock payments). Everything audited on admin writes. */
'use strict';
const { db, tx, nextSeq } = require('../db');
const { bad, notFound, rid } = require('../lib/util');
const { audit } = require('../lib/audit');
const ledger = require('./ledger');

const CURRENCIES = ['USD', 'GBP', 'AED', 'INR'];
const out = (r) => r && ({
  id: r.id, name: r.name, descr: r.descr || '', price: r.price, currency: r.currency,
  inrEquiv: r.inr_equiv, includes: (() => { try { return JSON.parse(r.includes || '[]'); } catch (e) { return []; } })(),
  active: !!r.active, created: r.created
});
const outOrder = (r) => r && ({
  id: r.id, packageId: r.package_id, userId: r.user_id, amount: r.amount, currency: r.currency,
  inrEquiv: r.inr_equiv, status: r.status, gatewayOrderId: r.gateway_order_id || '',
  gatewayPaymentId: r.gateway_payment_id || '', created: r.created
});

const get = (id) => db.prepare('SELECT * FROM nri_packages WHERE id=?').get(id);
const list = () => db.prepare('SELECT * FROM nri_packages ORDER BY price').all().map(out);
const listActive = () => db.prepare('SELECT * FROM nri_packages WHERE active=1 ORDER BY price').all().map(out);
const ordersFor = (userId) => db.prepare('SELECT * FROM nri_orders WHERE user_id=? ORDER BY created DESC').all(userId).map(outOrder);
const allOrders = () => db.prepare('SELECT * FROM nri_orders ORDER BY created DESC LIMIT 500').all().map(outOrder);

/* Admin CRUD. Package rows are never hard-deleted once orders exist —
   deactivate instead (same posture as temples/kits). */
function createPackage(uid, b) {
  if (!CURRENCIES.includes(b.currency)) throw bad('Unsupported currency');
  const price = Math.round(Number(b.price));
  if (!price || price <= 0) throw bad('Package price must be positive');
  const id = 'nrp' + rid(4);
  tx(() => {
    db.prepare('INSERT INTO nri_packages(id,name,descr,price,currency,inr_equiv,includes,active,created) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, String(b.name || '').trim().slice(0, 120), String(b.descr || '').slice(0, 500), price, b.currency,
           Math.round(Number(b.inrEquiv) || 0),
           JSON.stringify((Array.isArray(b.includes) ? b.includes : []).map((x) => String(x).slice(0, 120)).slice(0, 12)),
           1, Date.now());
  })();  /* NOTE: db.js tx() returns the wrapped transaction — it must be invoked */
  audit(uid, 'nri.package_create', 'nri_package', id, { name: b.name, price, currency: b.currency });
  return out(get(id));
}
function updatePackage(uid, id, b) {
  const p = get(id);
  if (!p) throw notFound('Package not found');
  const sets = [], args = [];
  if (b.name !== undefined) { sets.push('name=?'); args.push(String(b.name).trim().slice(0, 120)); }
  if (b.descr !== undefined) { sets.push('descr=?'); args.push(String(b.descr).slice(0, 500)); }
  if (b.price !== undefined) {
    const price = Math.round(Number(b.price));
    if (!price || price <= 0) throw bad('Package price must be positive');
    sets.push('price=?'); args.push(price);
  }
  if (b.currency !== undefined) {
    if (!CURRENCIES.includes(b.currency)) throw bad('Unsupported currency');
    sets.push('currency=?'); args.push(b.currency);
  }
  if (b.inrEquiv !== undefined) { sets.push('inr_equiv=?'); args.push(Math.round(Number(b.inrEquiv) || 0)); }
  if (b.includes !== undefined) { sets.push('includes=?'); args.push(JSON.stringify((Array.isArray(b.includes) ? b.includes : []).map((x) => String(x).slice(0, 120)).slice(0, 12))); }
  if (b.active !== undefined) { sets.push('active=?'); args.push(b.active ? 1 : 0); }
  if (!sets.length) throw bad('Nothing to update');
  tx(() => db.prepare('UPDATE nri_packages SET ' + sets.join(',') + ' WHERE id=?').run(...args, id))();
  audit(uid, 'nri.package_update', 'nri_package', id, { from: { price: p.price, active: p.active }, to: b }, { oldValue: { active: p.active }, newValue: { active: b.active !== undefined ? b.active : p.active } });
  return out(get(id));
}
function deletePackage(uid, id, reason) {
  const p = get(id);
  if (!p) throw notFound('Package not found');
  const used = db.prepare('SELECT COUNT(*) c FROM nri_orders WHERE package_id=?').get(id).c;
  if (used) throw bad('Past orders reference this package. Deactivate it instead.');
  tx(() => db.prepare('DELETE FROM nri_packages WHERE id=?').run(id))();
  audit(uid, 'nri.package_delete', 'nri_package', id, { name: p.name }, reason);
  return { ok: true };
}

/* Customer checkout. Idempotent per client key: a retried POST with the same
   key returns the original order (the partial unique index backs the guard).
   Mock mode settles PAID instantly (legacy behaviour); razorpay mode holds the
   order PENDING_PAYMENT and returns the gateway order for checkout.js — the
   NRI_PAYMENT ledger row is then written by verify() at the money moment. */
function checkout(uid, userId, { packageId, idem } = {}) {
  const p = get(String(packageId || ''));
  if (!p || !p.active) throw notFound('Package not available');
  const key = String(idem || '').trim();
  if (!key) throw bad('Idempotency key required');
  const scope = 'nri_order';
  const existing = db.prepare('SELECT result FROM idempotency_keys WHERE key=? AND scope=?').get(key.slice(0, 120), scope);
  if (existing) return JSON.parse(existing.result);
  const id = 'NR' + nextSeq('nri_seq', 5001);
  const gateway = require('./payments').mode() === 'razorpay';
  const order = { id, packageId: p.id, userId, amount: p.price, currency: p.currency, inrEquiv: p.inr_equiv, status: gateway ? 'PENDING_PAYMENT' : 'PAID', created: Date.now() };
  tx(() => {
    db.prepare('INSERT INTO nri_orders(id,package_id,user_id,amount,currency,inr_equiv,status,idem,gateway_order_id,created) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, p.id, userId, p.price, p.currency, p.inr_equiv, order.status, key.slice(0, 120), gateway ? 'pending' : '', order.created);
    db.prepare('INSERT INTO idempotency_keys(key,scope,result,created_at) VALUES(?,?,?,?)').run(key.slice(0, 120), scope, JSON.stringify(order), Date.now());
  })();
  if (!gateway) {
    /* one ledger row per order, in INR (inr_equiv) so money reports stay single-currency */
    ledger.dedupe({ type: 'NRI_PAYMENT', amount: p.inr_equiv, userId, refTable: 'nri_orders', refId: id, note: 'NRI package ' + p.name + ' (' + p.currency + ' ' + p.price + ')' });
  }
  return order;
}

/* Gateway money moment: verify the Razorpay signature against the stored
   gateway order, flip PENDING_PAYMENT -> PAID and write the (deduped) INR
   ledger row — the same contract as the kundali pay/verify path. */
function verify(uid, userId, id, { razorpay_order_id, razorpay_payment_id, razorpay_signature } = {}) {
  const pay = require('./payments');
  const r = db.prepare('SELECT * FROM nri_orders WHERE id=?').get(String(id || ''));
  if (!r || r.user_id !== userId) throw notFound('Order not found');
  if (r.status === 'PAID') return { ok: true, orderId: r.id, status: 'PAID' };
  if (r.status !== 'PENDING_PAYMENT') throw bad('This order is not awaiting payment');
  if (pay.mode() === 'razorpay') {
    if (!r.gateway_order_id || r.gateway_order_id !== String(razorpay_order_id || '') ||
        !pay.verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
      throw bad('Payment verification failed');
    }
  }
  tx(() => {
    db.prepare("UPDATE nri_orders SET status='PAID', gateway_order_id=?, gateway_payment_id=? WHERE id=?")
      .run(String(razorpay_order_id || r.gateway_order_id || '').slice(0, 80),
           String(razorpay_payment_id || 'MOCK' + rid(4)).slice(0, 80), r.id);
    /* replay-safe: a stored idem key of 'pending' is promoted to the verify key */
    const idem = db.prepare('SELECT idem FROM nri_orders WHERE id=?').get(r.id).idem;
    db.prepare("UPDATE idempotency_keys SET result=? WHERE key=? AND scope='nri_order' AND result LIKE '%PENDING_PAYMENT%'")
      .run(JSON.stringify({ ...outOrder(db.prepare('SELECT * FROM nri_orders WHERE id=?').get(r.id)), status: 'PAID' }), idem);
  })();
  const p = get(r.package_id);
  ledger.dedupe({ type: 'NRI_PAYMENT', amount: r.inr_equiv, userId, refTable: 'nri_orders', refId: r.id, note: 'NRI package ' + (p ? p.name : r.package_id) + ' (' + r.currency + ' ' + r.amount + ')' });
  return { ok: true, orderId: r.id, status: 'PAID' };
}

module.exports = { CURRENCIES, out, outOrder, get, list, listActive, ordersFor, allOrders, createPackage, updatePackage, deletePackage, checkout, verify };
