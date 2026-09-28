/* Centralized payout calculation engine (Phases 7-8).
   Single source of truth for payout math and status vocabulary:
     - booking completion (services/bookings.js) asks this module to create payouts;
     - admin finance actions (status transitions, holds, disbursement) go through it;
     - commission comes ONLY from admin-configurable settings (fallback: 'commission');
       no percentage is ever hard-coded at call sites.

   Status vocabulary (canonical):
     PENDING -> ON_HOLD -> PROCESSING -> DISBURSED
                                 |-> FAILED -> REVERSED
   Legacy rows ('Pending'/'Paid') are translated by legacyStatus().

   Per-payout breakdown columns live on the SAME payouts table (migration 012):
   gross_amount, commission_amt, tax_amt, refund_amt, adjustment_amt + net amount. */
'use strict';
const { db, tx, getSetting } = require('../db');
const { bad, conflict, notFound, today } = require('../lib/util');
const { audit } = require('../lib/audit');
const LEDGER = require('./ledger');

const STATUSES = ['PENDING', 'ON_HOLD', 'PROCESSING', 'DISBURSED', 'FAILED', 'REVERSED'];
const HOLDABLE = new Set(['PENDING', 'ON_HOLD', 'PROCESSING']);

/* Legacy -> canonical. Anything unknown stays as-is so inspection is loud, not lossy. */
function legacyStatus(s) {
  if (s === 'Pending' || s === 'pending') return 'PENDING';
  if (s === 'Paid' || s === 'paid') return 'DISBURSED';
  return s;
}

/* Resolves the admin-configurable payout rule set. Every knob lives in settings;
   nothing here is hard-coded at call sites (master rule: no hard-coded commission). */
function payoutRules() {
  const holds = getSetting('payout_holds', null);
  return {
    holds: Array.isArray(holds) ? holds
      : [{ reason: 'KYC Pending', check: 'pandit_kyc' },
         { reason: 'Bank Verification Pending', check: 'bank' },
         { reason: 'Customer Dispute', check: 'dispute' },
         { reason: 'Booking Under Review', check: 'review' },
         { reason: 'Refund Pending', check: 'refund' },
         { reason: 'Payment Reconciliation', check: 'reconciliation' },
         { reason: 'Admin Hold', check: 'admin' }]
  };
}

/* Returns the first matching hold descriptor, or null when the payout can flow. */
function findHold(row) {
  if (row.hold_reason) return { reason: row.hold_reason, note: row.hold_note || null };
  const rules = payoutRules().holds;
  if (row.pandit_id) {
    const pandit = db.prepare('SELECT status, account_reason FROM pandits WHERE id=?').get(row.pandit_id);
    const rule = pandit && rules.find((h) => h.check === 'pandit_kyc');
    if (rule && pandit.status !== 'verified') return rule;
    /* Phase 22: suspended/terminated pandits hold payouts with the documented reason. */
    if (pandit && pandit.account_reason) return { reason: 'Admin Hold', note: 'Pandit account suspended: ' + pandit.account_reason };
  }
  if (row.booking_id) {
    const b = db.prepare("SELECT esc FROM bookings WHERE id=?").get(row.booking_id);
    const rule = rules.find((h) => h.check === 'review');
    if (rule && b && b.esc) return rule;
  }
  return null;
}

/* The centralized calculation. Inputs carry only raw ingredients; every derived
   number is computed here. net = gross - commission - tax - refund - adjustments. */
function calculate({ gross, commissionPct, taxAmt = 0, refundAmt = 0, adjustmentAmt = 0 }) {
  const grossAmt = Math.round(gross || 0);
  const commission = Math.round((grossAmt * (commissionPct || 0)) / 100);
  const net = grossAmt - commission - Math.round(taxAmt) - Math.round(refundAmt) - Math.round(adjustmentAmt);
  return { gross_amount: grossAmt, commission_amt: commission, tax_amt: Math.round(taxAmt),
           refund_amt: Math.round(refundAmt), adjustment_amt: Math.round(adjustmentAmt), net };
}

/* One payout row per booking completion (PENDING). Commission comes from the
   'commission' setting — the same knob the booking price path uses — so admin
   changes apply to payouts created after the change, never retroactively. */
function createForBooking(row, panditId) {
  const q = (() => { try { return JSON.parse(row.q || '{}'); } catch (e) { return {}; } })();
  /* Phase 9: effective-dated commission tier wins; the 'commission' setting stays
     the fallback so behaviour only changes when an admin defines tiers. */
  const pujaCat = db.prepare('SELECT cat FROM pujas WHERE id=?').get(row.puja_id);
  const tier = LEDGER.commissionPct({ panditId, serviceCategory: (pujaCat && pujaCat.cat) || 'ALL' });
  const pct = tier.pct;
  const calc = calculate({ gross: q.svc || 0, commissionPct: pct });
  const n = db.prepare('SELECT COUNT(*) c FROM payouts').get().c + 1;
  const id = 'PO' + n + '-' + row.id;
  db.prepare(`INSERT INTO payouts(id,pandit_id,amount,date,status,booking_id,gross_amount,
    commission_amt,tax_amt,refund_amt,adjustment_amt,currency)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, panditId, calc.net, today(), 'PENDING', row.id, calc.gross_amount,
         calc.commission_amt, calc.tax_amt, calc.refund_amt, calc.adjustment_amt, 'INR');
  /* Phase 10: the pandit's share is a DAKSHINA ledger entry from day one; it is
     matched by the negative PAYOUT row when the money actually leaves. */
  if (calc.net > 0) LEDGER.dedupe({ type: 'DAKSHINA', amount: calc.net, panditId, bookingId: row.id, refTable: 'payouts', refId: id, note: tier.tier ? 'Pandit share (tier ' + tier.tier + ')' : 'Pandit share' });
  const hold = findHold({ id, pandit_id: panditId, booking_id: row.id });
  if (hold) placeHold(id, hold.reason, hold.note, 'system');
  return id;
}

/* Money columns writable through transitions. Adjustment recomputes net against the
   STORED commission/tax/refund (never re-derives them), and is only allowed while the
   payout has not left the platform's hands. */
function setAdjustment(id, amt, actorUserId, reason) {
  const row = get(id);
  const st = legacyStatus(row.status);
  if (['DISBURSED', 'REVERSED', 'FAILED'].includes(st)) throw conflict('Payout is ' + st + ' — adjustments only apply before disbursement');
  const gross = row.gross_amount != null ? row.gross_amount : row.amount;
  const commission = row.commission_amt != null ? row.commission_amt : 0;
  const calc = calculate({ gross, commissionPct: 0, taxAmt: row.tax_amt || 0,
                           refundAmt: row.refund_amt || 0, adjustmentAmt: amt || 0 });
  const net = gross - commission - calc.tax_amt - calc.refund_amt - calc.adjustment_amt;
  db.prepare('UPDATE payouts SET amount=?, adjustment_amt=? WHERE id=?')
    .run(net, calc.adjustment_amt, id);
  /* Phase 10 ledger: the DAKSHINA entry follows the payout's net amount. */
  if (row.amount !== net) LEDGER.dedupe({ type: 'DAKSHINA', amount: net - (row.amount || 0), panditId: row.pandit_id, bookingId: row.booking_id, refTable: 'payouts', refId: id + ':adjust', note: 'Adjustment' + (reason ? ': ' + String(reason).slice(0, 100) : '') });
  audit(actorUserId, 'payout.adjustment', 'payout', id,
    { from: row.adjustment_amt || 0, to: calc.adjustment_amt, net, ...(reason ? { reason: String(reason).slice(0, 200) } : {}) });
  return get(id);
}

function get(id) { return db.prepare('SELECT * FROM payouts WHERE id=?').get(id); }

/* Admin transitions. Every transition validates the source status, stamps the
   corresponding date column, writes the enriched audit record, and never lets a
   DISBURSED payout change silently (reversal is its own explicit step). */
function transition(id, action, actorUserId, { reason, note, paymentRef, utr } = {}) {
  const row = get(id);
  if (!row) throw notFound('Payout not found');
  const from = legacyStatus(row.status);

  let to, patch = {};
  if (action === 'process') {
    if (from === 'ON_HOLD' && !reason) throw bad('Lift the hold with a reason before processing');
    if (!['PENDING', 'ON_HOLD'].includes(from)) throw conflict('Cannot process a payout in ' + from);
    to = 'PROCESSING';
    patch = { processing_date: today() };
    if (reason) patch = { ...patch, hold_reason: null, hold_note: null };
  } else if (action === 'disburse') {
    if (from !== 'PROCESSING') throw conflict('Only PROCESSING payouts can be disbursed (now ' + from + ')');
    if (!paymentRef && !utr) throw bad('A payment reference or UTR is required to disburse');
    to = 'DISBURSED';
    patch = { disbursement_date: today(), payment_ref: paymentRef || null, utr: utr || null };
    /* Phase 10 ledger: commission realized + money out. Idempotent on payout id. */
    const gross = row.gross_amount != null ? row.gross_amount : row.amount;
    const commission = row.commission_amt != null ? row.commission_amt : 0;
    if (commission > 0) LEDGER.dedupe({ type: 'COMMISSION', amount: commission, panditId: row.pandit_id, bookingId: row.booking_id, refTable: 'payouts', refId: id + ':commission', note: 'Commission on ' + id });
    if (row.amount > 0) LEDGER.dedupe({ type: 'PAYOUT', amount: -row.amount, panditId: row.pandit_id, bookingId: row.booking_id, refTable: 'payouts', refId: id + ':payout', note: 'Disbursement' + (utr ? ' UTR ' + utr : paymentRef ? ' ref ' + paymentRef : '') });
  } else if (action === 'hold') {
    if (!HOLDABLE.has(from)) throw conflict('Cannot hold a payout in ' + from);
    if (!reason) throw bad('A hold reason is required — pandits must see WHY a payout is on hold');
    to = 'ON_HOLD';
    patch = { hold_reason: String(reason).slice(0, 120), hold_note: note ? String(note).slice(0, 500) : null };
  } else if (action === 'fail') {
    if (!['PENDING', 'ON_HOLD', 'PROCESSING'].includes(from)) throw conflict('Cannot fail a payout in ' + from);
    if (!reason) throw bad('A reason is required to mark a payout FAILED');
    to = 'FAILED';
    patch = { hold_reason: null };
  } else if (action === 'reverse') {
    if (from !== 'DISBURSED') throw conflict('Only DISBURSED payouts can be reversed (now ' + from + ')');
    if (!reason) throw bad('A reason is required to reverse a disbursed payout');
    to = 'REVERSED';
    patch = {};
  } else {
    throw bad('Unknown payout action');
  }

  const sets = ['status=?'], args = [to];
  for (const [k, val] of Object.entries(patch)) { sets.push(k + '=?'); args.push(val); }
  args.push(id);
  db.prepare('UPDATE payouts SET ' + sets.join(',') + ' WHERE id=?').run(...args);
  audit(actorUserId, 'payout.' + action, 'payout', id,
    { from, to, ...(reason ? { reason: String(reason).slice(0, 200) } : {}), ...(note ? { note } : {}),
      ...(paymentRef ? { paymentRef } : {}), ...(utr ? { utr } : {}) });
  return get(id);
}

function placeHold(id, reason, note, actorUserId) {
  return transition(id, 'hold', actorUserId || 'system', { reason, note });
}

module.exports = { STATUSES, legacyStatus, payoutRules, findHold, calculate,
                   createForBooking, transition, placeHold, setAdjustment, get };
