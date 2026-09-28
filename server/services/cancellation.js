/* Cancellation & rescheduling engine (master plan Phase 16).
   ONE writer for booking cancellations: `cancelInternal` moves here from
   services/bookings.js (the module keeps a re-export so every existing caller
   — customer cancel, admin status, expire-unpaid, payment-gateway rollback —
   keeps working unchanged). Rules that were hardcoded become settings-backed
   policy with the exact legacy defaults, so behaviour only changes when an
   admin edits the policy:

     policy = { full: 48, part: 24, fullPct: 100, partPct: 75, latePct: 50,
                noshowPct: 25, compPct: 50, noticeHours: 24 }

     full/part   refund tier windows in hours before the puja (full ≥ 48h,
                 part ≥ 24h, otherwise late). Legacy: shared/pricing.js
                 refundPct() = >48h 100%, >24h 75%, else 50%.
     noshowPct   refund to the customer when a pandit misses the puja
                 (default 25% — the customer is refunded AND the pandit is
                 paid nothing).
     compPct     pandit compensation % of the net for pandit-side cancels and
                 no-shows (default 50%; legacy: pandit-initiated cancels only
                 released the slot, no payout, no customer refund).
     noticeHours minimum notice a pandit must give (default 24h) — below it the
                 cancellation counts against the pandit and no compensation is
                 paid.

   Also new:
   - `panditCancel(pid, id, reason)` — pandit-side cancellation: the customer
     always gets the standard tier refund (the cancellation is not their
     fault); the pandit earns compensation only when cancelling OUTSIDE the
     notice window; and the cancellation stays attributed to the pandit
     (pandit_id intact, unlike the old reject path which detached them), so
     the QA cancelPct metric sees it.
   - `panditNoShowSweep()` — past-date, still-active bookings with a pandit
     are cancelled as no-shows: the customer is refunded noshowPct, the pandit
     receives a compensation payout (compPct of their share) written to the
     ledger, and each row is audited. Idempotent: cancelled rows no longer
     match the finder's WHERE clause, so re-running is safe.
   - `adminNoShow(id, actor)` — admin forces a no-show now (same mechanics,
     explicit audit).

   Money rules (unchanged invariants):
   - refunds always flow through the deduped REFUND ledger entry in
     cancelInternal (idempotent on booking id);
   - compensation flows through the deduped DAKSHINA ledger (ref
     payouts:{booking}:comp) and creates a real PENDING payout row so the
     normal payout lifecycle (process → disburse) carries it;
   - the ledger is the only money writer; this engine never touches payouts
     columns directly except to insert the compensation payout row.
*/
'use strict';
const { db, tx, getSetting, setSetting, nextSeq } = require('../db');
const P = require('../../shared/pricing');
const { j, today, addDays, bad, notFound, conflict } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('./notify');
const LEDGER = require('./ledger');

const DEFAULTS = { full: 48, part: 24, fullPct: 100, partPct: 75, latePct: 50, noshowPct: 25, compPct: 50, noticeHours: 24 };

const policy = () => {
  const raw = getSetting('cancellation_policy', {}) || {};
  return Object.assign({}, DEFAULTS, raw);
};

/* Same tier shape as before (pct), plus which tier fired, for the log/audit. */
function refundTier(date, slot, p) {
  const pol = p || policy();
  const h = P.hoursUntil(date, slot);
  if (h > pol.full) return { pct: pol.fullPct, tier: 'full' };
  if (h > pol.part) return { pct: pol.partPct, tier: 'part' };
  return { pct: pol.latePct, tier: 'late' };
}

/* ONE cancellation writer. pct = customer refund percent (0 = none).
   by = 'customer' | 'admin' | 'system' | 'pandit' | 'noshow'. */
function cancelInternal(row, pct, reason, sendNotice = true, by = 'system') {
  const q = j(row.q, {}), paid = j(row.pay, {}).paid;
  const refund = paid && pct > 0 ? { amt: Math.round(q.total * pct / 100), pct, state: 'Initiated' } : null;
  tx(() => {
    db.prepare("UPDATE bookings SET status='Cancelled', refund=?, log=? WHERE id=?").run(refund && JSON.stringify(refund), logAppend(row, reason), row.id);
    releaseResources(row);
    if (refund) LEDGER.dedupe({ type: 'REFUND', amount: -refund.amt, userId: row.user_id, panditId: row.pandit_id, bookingId: row.id, refTable: 'bookings', refId: row.id + ':refund', note: 'Cancellation refund (' + pct + '%)' });
  })();
  if (sendNotice) notify(row.user_id, 'Email', `Booking ${row.id} cancelled.` + (refund ? ` Refund of Rs ${refund.amt} initiated.` : ''));
  audit(null, 'booking.cancelled', 'booking', row.id,
    { by, reason, refundPct: pct || 0, refundAmt: refund ? refund.amt : 0 },
    { newValue: { status: 'Cancelled', by, reason } });
  return db.prepare('SELECT * FROM bookings WHERE id=?').get(row.id);
}

/* Shared helpers kept byte-compatible with the previous bookings.js versions. */
const logAppend = (row, text) => { const l = j(row.log, []); l.push([text, today()]); return JSON.stringify(l); };
function releaseResources(row) {
  const q = j(row.q, {}), ops = j(row.ops, {});
  if (q.pts) db.prepare('UPDATE users SET pts=pts+? WHERE id=?').run(q.pts, row.user_id);
  if (ops.sam !== 'Delivered') j(row.sam, []).forEach((id) => db.prepare('UPDATE kits SET stock=stock+1 WHERE id=?').run(id));
}

function customerCancel(user, id) {
  const row = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  if (!row || row.user_id !== user.id) throw notFound('Booking not found');
  if (!['New', 'Confirmed', 'Assigned', 'PendingPayment'].includes(row.status)) throw bad('This booking can no longer be cancelled');
  const t = refundTier(row.date, row.slot);
  return cancelInternal(row, t.pct, 'Cancelled by customer', true, 'customer');
}

function reschedule(user, id, body, v) {
  const row = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  if (!row || row.user_id !== user.id) throw notFound('Booking not found');
  if (!['New', 'Confirmed', 'Assigned'].includes(row.status)) throw bad('This booking can no longer be rescheduled');
  const date = v.date(body.date);
  if (date < addDays(1)) throw bad('Choose a date from tomorrow onwards');
  const slot = v.oneOf(body.slot, P.SLOTS, 'Time slot');
  const AV = require('./availability');
  if (row.pandit_id) {
    const p = db.prepare('SELECT * FROM pandits WHERE id=?').get(row.pandit_id);
    const vv = AV.check(p, date, slot, { mode: row.mode, city: j(row.addr, {}).city, skipId: row.id });
    if (!vv.ok) throw conflict('Your pandit is not available then: ' + vv.reason);
  }
  try { db.prepare('UPDATE bookings SET date=?, slot=?, log=? WHERE id=?').run(date, slot, logAppend(row, 'Rescheduled'), id); }
  catch (e) { if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw conflict('Your pandit is not free then.'); throw e; }
  notify(user.id, 'SMS', `Booking ${id} rescheduled to ${date}, ${slot}.`);
  return db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
}

/* ---------------- Pandit-side cancellation + no-show ---------------- */

/* Compensation payout: a real PENDING payout row + its DAKSHINA ledger entry,
   carried by the normal payout lifecycle. Idempotent per booking. */
function compensate(panditId, row, net) {
  const amt = Math.round(net * policy().compPct / 100);
  if (amt <= 0) return null;
  const id = 'POC' + nextSeq('payout_comp_seq', 1) + '-' + row.id;
  db.prepare(`INSERT INTO payouts(id,pandit_id,amount,date,status,booking_id,gross_amount,commission_amt,tax_amt,refund_amt,adjustment_amt,currency)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, panditId, amt, today(), 'PENDING', row.id, amt, 0, 0, 0, 0, 'INR');
  LEDGER.dedupe({ type: 'DAKSHINA', amount: amt, panditId, bookingId: row.id, refTable: 'payouts', refId: id, note: 'Cancellation compensation (' + policy().compPct + '%)' });
  return id;
}

/* The pandit's share of this booking's money (payout net when one exists —
   compensation should mirror what the pandit would actually have earned). */
function panditNet(row) {
  const po = db.prepare('SELECT amount FROM payouts WHERE booking_id=? ORDER BY id DESC').get(row.id);
  if (po) return Math.max(0, po.amount || 0);
  const q = j(row.q, {});
  return Math.max(0, (q.svc || 0) - Math.round((q.svc || 0) * (getSetting('commission', 20) || 0) / 100));
}

function panditCancel(pid, id, reason) {
  const row = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  if (!row || row.pandit_id !== pid) throw notFound('Booking not found');
  if (!['New', 'Confirmed', 'Assigned'].includes(row.status)) throw bad('This booking can no longer be cancelled');
  if (row.status === 'Started') throw bad('A started puja cannot be cancelled — contact the admin');
  const pol = policy();
  const hours = P.hoursUntil(row.date, row.slot);
  const withinNotice = hours < pol.noticeHours;
  const t = refundTier(row.date, row.slot, pol);
  let compId = null;
  if (!withinNotice) compId = compensate(pid, row, panditNet(row));
  cancelInternal(row, t.pct, 'Cancelled by pandit' + (reason ? ': ' + String(reason).slice(0, 160) : ''), true, 'pandit');
  audit(pid, 'booking.cancelled_by_pandit', 'booking', id,
    { withinNotice, hours: Math.round(hours), compensation: compId || 'none', customerRefundPct: t.pct },
    { newValue: { status: 'Cancelled', by: 'pandit', withinNotice } });
  if (!withinNotice) notify(pid, 'WhatsApp', `You cancelled booking ${id} with enough notice. Compensation of the pandit share was credited to your payouts.`);
  else notify(pid, 'WhatsApp', `Booking ${id} was cancelled inside the ${pol.noticeHours}h notice window — no compensation for this booking.`);
  return db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
}

/* Cancel one booking as a no-show: customer refunded noshowPct, pandit paid
   compensation (they cleared their calendar and showed up in good faith). */
function noShowCancel(row, actorUserId) {
  const pol = policy();
  const q = j(row.q, {});
  cancelInternal(row, pol.noshowPct, 'Pandit did not arrive (no-show)', true, 'noshow');
  const compId = compensate(row.pandit_id, row, panditNet(row));
  audit(actorUserId, 'booking.noshow', 'booking', row.id,
    { panditId: row.pandit_id, customerRefundPct: pol.noshowPct, compensation: compId || 'none' },
    { newValue: { status: 'Cancelled', by: 'noshow' } });
  if (row.pandit_id) notify(row.pandit_id, 'Email', `Booking ${row.id} was recorded as a no-show. Compensation was credited to your payouts; this affects your service metrics.`);
  return compId;
}

/* Sweep: past-date bookings still active with a pandit = the pandit missed them.
   Same WHERE marks nothing twice (rows become Cancelled in the same statement
   set), so re-running is safe. Returns the list of booking ids handled. */
function panditNoShowSweep(actorUserId) {
  const t = today();
  const rows = db.prepare(`SELECT * FROM bookings WHERE pandit_id IS NOT NULL AND date < ?
    AND status IN ('New','Confirmed','Assigned','Started')`).all(t);
  const handled = [];
  for (const row of rows) { noShowCancel(row, actorUserId); handled.push(row.id); }
  return handled;
}

/* Admin: record a no-show now (before or on the date) with an explicit reason. */
function adminNoShow(id, actorUserId, reason) {
  const row = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  if (!row) throw notFound('Booking not found');
  if (['Completed', 'Cancelled'].includes(row.status)) throw bad('This booking is closed');
  if (!row.pandit_id) throw bad('No pandit is assigned to this booking');
  noShowCancel(row, actorUserId);
  return db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
}

function adminCancel(id, actorUserId, reason) {
  const row = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  if (!row) throw notFound('Booking not found');
  if (['Completed', 'Cancelled'].includes(row.status)) throw bad('Closed bookings cannot be cancelled');
  return cancelInternal(row, 100, reason || 'Cancelled by admin', true, 'admin');
}

/* Boot-armed schedule (same pattern as the KYC sweep): NOSHOW_SWEEP_MS
   default 1h, 0 disables. Runs the sweep with actor null (system). */
function startNoShowSweeper() {
  const ms = Number(process.env.NOSHOW_SWEEP_MS === undefined ? 3600000 : process.env.NOSHOW_SWEEP_MS);
  if (!ms) return null;
  const t = setInterval(() => { try { panditNoShowSweep(null); } catch (e) { console.error('[noshow] sweep failed:', e.message); } }, ms);
  if (t.unref) t.unref();
  return t;
}

/* Policy read/update (admin surface). Audited with old→new. Pct fields are
   0..100; hour-window fields go up to a year (8760h) — they are windows, not
   percentages, and must not be capped at 100. */
const HOUR_KEYS = ['full', 'part', 'noticeHours'], PCT_KEYS = ['fullPct', 'partPct', 'latePct', 'noshowPct', 'compPct'];
function getPolicy() { return policy(); }
function updatePolicy(actorUserId, body) {
  const cur = policy();
  const b = body || {};
  const next = Object.assign({}, cur);
  for (const k of Object.keys(DEFAULTS)) {
    if (b[k] === undefined) continue;
    const n = Number(b[k]);
    const max = HOUR_KEYS.includes(k) ? 8760 : 100;
    if (!Number.isFinite(n) || n < 0 || n > max) throw bad(k + ' must be between 0 and ' + max);
    next[k] = n;
  }
  if (!(next.full > next.part)) throw bad('The full-refund window must be longer than the part-refund window');
  setSetting('cancellation_policy', next);
  audit(actorUserId, 'settings.cancellation_policy', 'settings', 'cancellation_policy',
    { from: { full: cur.full, part: cur.part, latePct: cur.latePct, noshowPct: cur.noshowPct, compPct: cur.compPct },
      to: { full: next.full, part: next.part, latePct: next.latePct, noshowPct: next.noshowPct, compPct: next.compPct } },
    { oldValue: { full: cur.full, part: cur.part }, newValue: { full: next.full, part: next.part } });
  return next;
}

module.exports = { DEFAULTS, policy, refundTier, cancelInternal, releaseResources, logAppend,
                   customerCancel, reschedule, panditCancel, panditNoShowSweep, adminNoShow, adminCancel,
                   compensate, panditNet, getPolicy, updatePolicy, startNoShowSweeper };
