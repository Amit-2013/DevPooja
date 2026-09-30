/* Review hold for bookings of flagged pandits (per-pandit flagging follow-up).
   While a pandit is flagged by the reopen digest (live incidents reopened
   across DISTINCT bookings beyond REOPEN_LIMIT), NEW bookings carrying their
   id are stamped with review_hold=1 + hold_reason. The assigned pandit cannot
   accept or start a held booking until an admin releases it or the flag
   clears — resolving every live incident auto-releases all held bookings at
   the next boot/digest view (sweep), and admins always have the explicit
   release endpoint. The hold is per-BOOKING, never a pandit-level block:
   bookings created BEFORE the flag (or after it clears) are untouched.
   Mirrors app/services/review_hold.py. */
'use strict';
const { db } = require('../db');
const INC = require('./incidents');

const REOPEN_LIMIT = INC.REOPEN_LIMIT;

function reasonFor(pid) {
  return `Review hold: pandit ${pid} is flagged for repeated incident reopens across distinct bookings (threshold ${REOPEN_LIMIT}). Awaiting admin review.`;
}

/* True while the pandit is currently flagged by the digest. */
function isFlagged(pid) {
  return INC.flaggedPanditIds().includes(pid);
}

/* Stamp a booking that was just created/assigned to a flagged pandit. */
function stampOnCreate(bookingId, panditId) {
  if (!panditId || !isFlagged(panditId)) return false;
  db.prepare('UPDATE bookings SET review_hold=1, hold_reason=? WHERE id=?').run(reasonFor(panditId), bookingId);
  return true;
}

/* Pandit-side guard: accept/start refuse while the hold stands. The pandit
   sees the reason verbatim. Falls back to a release when the flag has
   already cleared (belt-and-braces alongside the sweep). */
function guard(booking, action) {
  if (!booking || !booking.review_hold) return;
  if (!isFlagged(booking.pandit_id)) { releaseAllFor(booking.pandit_id, 'flag-cleared'); return; }
  throw require('../lib/util').conflict(
    `This booking is under review hold: ${reasonFor(booking.pandit_id)} You cannot ${action} it yet — the admin team has been asked to review.`);
}

/* Explicit admin release (POST /admin/bookings/:id/release-hold). */
function release(id, actor) {
  const row = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  if (!row) throw require('../lib/util').notFound('Booking not found');
  if (!row.review_hold) return { booking: row, released: false };
  db.prepare('UPDATE bookings SET review_hold=0, hold_reason=NULL WHERE id=?').run(id);
  require('../lib/audit').audit(actor, 'booking.hold_released', 'booking', id,
    { from: 1, to: 0, reason: 'admin release' });
  const p = db.prepare('SELECT user_id FROM pandits WHERE id=?').get(row.pandit_id);
  if (p && p.user_id) require('./notify').notify(p.user_id, 'In-App', `Booking ${id} is released from review hold — you can accept it now.`);
  return { booking: db.prepare('SELECT * FROM bookings WHERE id=?').get(id), released: true };
}

/* Auto-release every held booking of pandits whose flag has cleared. Called
   at boot (like the KYC/no-show sweeps) and lazily from the digest view so
   resolutions free bookings without waiting for a restart. */
function sweep() {
  const held = db.prepare('SELECT DISTINCT pandit_id pid FROM bookings WHERE review_hold=1').all();
  let released = 0;
  for (const { pid } of held) {
    if (!isFlagged(pid)) released += releaseAllFor(pid, 'flag-cleared');
  }
  return released;
}

function releaseAllFor(pid, why) {
  const rows = db.prepare('SELECT id FROM bookings WHERE review_hold=1 AND pandit_id=?').all(pid);
  if (!rows.length) return 0;
  db.prepare('UPDATE bookings SET review_hold=0, hold_reason=NULL WHERE review_hold=1 AND pandit_id=?').run(pid);
  const audit = require('../lib/audit');
  const notify = require('./notify').notify;
  const p = db.prepare('SELECT user_id FROM pandits WHERE id=?').get(pid);
  rows.forEach((r) => audit.audit(null, 'booking.hold_auto_released', 'booking', r.id,
    { panditId: pid, why }));
  if (p && p.user_id) notify(p.user_id, 'In-App', `${rows.length} booking${rows.length > 1 ? 's' : ''} released from review hold — the repeat-reopen flag on your account has cleared.`);
  return rows.length;
}

module.exports = { REOPEN_LIMIT, reasonFor, isFlagged, stampOnCreate, guard, release, sweep, releaseAllFor };
