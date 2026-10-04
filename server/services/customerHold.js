/* Customer-conduct escalation (flaggedCustomers follow-up): a SOFT review flag
   on NEW bookings of flagged customers. While a customer is flagged by the
   reopen digest (live incidents reopened across DISTINCT bookings beyond
   REOPEN_LIMIT), bookings they create are stamped with customer_hold=1 +
   customer_hold_reason. The fulfilment flow is deliberately NOT blocked — the
   pandit can still accept/start (a flagged CUSTOMER is a trust signal for the
   ops team, not a fulfilment blocker; the coupon/discount-hold alternative was
   rejected for punishing through an unrelated channel with no review flow).
   Admins see the hold on every booking surface and clear it with the explicit
   release endpoint; resolving every live incident auto-releases held bookings
   at the next boot/digest view. Per-BOOKING only — bookings created before the
   flag (or after it clears) are untouched. Mirrors app/services/customer_hold.py. */
'use strict';
const { db } = require('../db');
const INC = require('./incidents');
const { notify } = require('./notify');

const REOPEN_LIMIT = INC.REOPEN_LIMIT;

function reasonFor(cid) {
  return `Customer review flag: this customer is on the conduct watchlist (reopened incidents across distinct bookings, threshold ${REOPEN_LIMIT}). Awaiting admin review — the booking itself proceeds normally.`;
}

/* True while the customer is currently flagged by the digest. */
function isFlagged(cid) {
  return INC.flaggedCustomers().some((x) => x.customerId === cid);
}

/* Stamp a booking that was just created by a flagged customer. Ops hears about it
   at STAMP time through the standard in-app notifs store — the badge on the
   bookings row was the only signal before, so the hold went unnoticed until
   someone opened the tab. */
function stampOnCreate(bookingId, customerId) {
  if (!customerId || !isFlagged(customerId)) return false;
  db.prepare('UPDATE bookings SET customer_hold=1, customer_hold_reason=? WHERE id=?').run(reasonFor(customerId), bookingId);
  const cu = db.prepare('SELECT name FROM users WHERE id=?').get(customerId);
  const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all();
  admins.forEach((a) => notify(a.id, 'In-App',
    `Customer hold applied: booking ${bookingId} by ${cu ? cu.name : customerId} — new booking by a flagged customer, awaiting review.`));
  return true;
}

/* Explicit admin release (POST /admin/bookings/:id/release-customer-hold). */
function release(id, actor) {
  const row = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  if (!row) throw require('../lib/util').notFound('Booking not found');
  if (!row.customer_hold) return { booking: row, released: false };
  db.prepare('UPDATE bookings SET customer_hold=0, customer_hold_reason=NULL WHERE id=?').run(id);
  require('../lib/audit').audit(actor, 'booking.customer_hold_released', 'booking', id,
    { from: 1, to: 0, reason: 'admin release' });
  return { booking: db.prepare('SELECT * FROM bookings WHERE id=?').get(id), released: true };
}

/* Auto-release every held booking of customers whose flag has cleared. Called
   at boot and lazily from the digest view, like the pandit-hold sweep. */
function sweep() {
  const held = db.prepare('SELECT DISTINCT user_id cid FROM bookings WHERE customer_hold=1 AND user_id IS NOT NULL').all();
  let released = 0;
  for (const { cid } of held) {
    if (!isFlagged(cid)) released += releaseAllFor(cid, 'flag-cleared');
  }
  return released;
}

/* Per-customer drill-in: every currently held booking of ONE flagged customer,
   in the admin booking-row shape the FE already renders. */
function heldFor(cid) {
  return db.prepare('SELECT * FROM bookings WHERE customer_hold=1 AND user_id=? ORDER BY created DESC').all(cid)
    .map(require('../lib/serialize').booking);
}

/* Batch release: clears EVERY held booking of one flagged customer at once.
   One explicit audited release per booking (the SAME audit as the single
   endpoint) so the audit trail and reports stay uniform — never one opaque
   bulk row. Returns the ids that were actually held. */
function releaseBatch(cid, actor) {
  const ids = db.prepare('SELECT id FROM bookings WHERE customer_hold=1 AND user_id=?').all(cid).map((r) => r.id);
  let released = 0;
  for (const id of ids) { if (release(id, actor).released) released++; }
  return { released, ids };
}

function releaseAllFor(cid, why) {
  const rows = db.prepare('SELECT id FROM bookings WHERE customer_hold=1 AND user_id=?').all(cid);
  if (!rows.length) return 0;
  db.prepare('UPDATE bookings SET customer_hold=0, customer_hold_reason=NULL WHERE customer_hold=1 AND user_id=?').run(cid);
  const audit = require('../lib/audit');
  rows.forEach((r) => audit.audit(null, 'booking.customer_hold_auto_released', 'booking', r.id,
    { customerId: cid, why }));
  return rows.length;
}

module.exports = { REOPEN_LIMIT, reasonFor, isFlagged, stampOnCreate, release, heldFor, releaseBatch, sweep, releaseAllFor };
