/* Incident reporting (master plan Phase 20) — activates the migration-014
   `incidents` table (schema unchanged; the model was already mirrored).

   Who reports: the PANDIT assigned to a booking (their on-ground safety and
   conduct channel: customer behaviour, payment refusal on arrival, unsafe
   locations, samagri disputes). A report may reference the booking — then the
   customer is linked automatically from it. Ownership is enforced: a pandit
   can only report against a booking assigned to them, and can only read their
   own reports.

   Categories (fixed vocabulary, mirrors the master plan's on-ground set):
     SAFETY_CONCERN      unsafe location, threat, harassment, accident
     CUSTOMER_CONDUCT    abusive language, unreasonable demands, no-show by customer
     PAYMENT_ISSUE       payment refused on arrival, coupon/quote disputes
     SAMAGRI_ISSUE       missing/tampered/wrong kit or prasad
     OTHER               anything else (description is mandatory anyway)

   Admin triage states: OPEN → UNDER_REVIEW → RESOLVED | DISMISSED.
     UNDER_REVIEW requires an admin note (what is being checked);
     RESOLVED requires a resolution (what was done — the pandit sees it);
     DISMISSED requires a reason. Closed states are terminal; reopening is not
     offered (audit history keeps the trail).

   Evidence: files uploaded through the EXISTING magic-checked media pipeline
   (same dirs/pipeline as puja photos; images + video, 40 MB), stored as
   /media URLs in the incidents.evidence JSON array. Server-side ownership of
   every file path is guaranteed by the upload middleware, never by the client.

   Every write is audited (`incident.reported/triage`) with old→new; the pandit
   is notified on triage decisions; admins are notified of new reports via the
   in-app channel (the admin users row).
*/
'use strict';
const { db, tx } = require('../db');
const { bad, notFound, conflict, rid } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('./notify');

const CATEGORIES = ['SAFETY_CONCERN', 'CUSTOMER_CONDUCT', 'PAYMENT_ISSUE', 'SAMAGRI_ISSUE', 'OTHER'];
const STATUSES = ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'];
const CLOSED = ['RESOLVED', 'DISMISSED'];

const get = (id) => db.prepare('SELECT * FROM incidents WHERE id=?').get(id);

const out = (r) => r && ({
  id: r.id, panditId: r.pandit_id, bookingId: r.booking_id, customerId: r.customer_id,
  category: r.category, description: r.description, evidence: (() => { try { return JSON.parse(r.evidence || '[]'); } catch (e) { return []; } })(),
  status: r.status, adminNotes: r.admin_notes || '', resolution: r.resolution || '',
  reportedAt: r.reported_at, resolvedAt: r.resolved_at
});

function list({ status } = {}) {
  const rows = status && STATUSES.includes(status)
    ? db.prepare('SELECT * FROM incidents WHERE status=? ORDER BY reported_at DESC, id DESC').all(status)
    : db.prepare('SELECT * FROM incidents ORDER BY reported_at DESC, id DESC').all();
  return rows.map(out);
}
function forPandit(panditId) {
  return db.prepare('SELECT * FROM incidents WHERE pandit_id=? ORDER BY reported_at DESC, id DESC').all(panditId).map(out);
}
function counts() {
  const rows = db.prepare('SELECT status, COUNT(*) n FROM incidents GROUP BY status').all();
  const c = { OPEN: 0, UNDER_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 };
  rows.forEach((r) => { c[r.status] = r.n; });
  return c;
}

/* Pandit reports an incident. bookingId optional but validated for ownership. */
function report(panditId, { bookingId, category, description, evidence = [] }) {
  const p = db.prepare('SELECT * FROM pandits WHERE id=?').get(panditId);
  if (!p) throw notFound('Pandit not found');
  if (!CATEGORIES.includes(category)) throw bad('Unknown incident category');
  const desc = String(description || '').trim();
  if (desc.length < 10) throw bad('Describe the incident in at least 10 characters');
  let customerId = null;
  let booking = null;
  if (bookingId) {
    booking = db.prepare('SELECT * FROM bookings WHERE id=?').get(String(bookingId));
    if (!booking) throw notFound('Booking not found');
    if (booking.pandit_id !== panditId) throw bad('You can only report incidents for bookings assigned to you');
    customerId = booking.user_id;
  }
  const urls = (Array.isArray(evidence) ? evidence : [])
    .filter((u) => typeof u === 'string' && u.startsWith('/media/'))
    .map((u) => u.slice(0, 200)).slice(0, 8);
  const id = 'INC' + rid(6);
  tx(() => {
    db.prepare(`INSERT INTO incidents(id,pandit_id,booking_id,customer_id,category,description,evidence,status,reported_at)
      VALUES(?,?,?,?,?,?,?,'OPEN',?)`)
      .run(id, panditId, booking ? booking.id : null, customerId, category, desc.slice(0, 2000),
           JSON.stringify(urls), Date.now());
  })();
  /* actor is the pandit's USER id — audit roles derive from the users row */
  audit(p.user_id || panditId, 'incident.reported', 'incident', id,
    { category, bookingId: booking ? booking.id : null, evidenceCount: urls.length },
    { newValue: { status: 'OPEN', category } });
  /* notify the admin team in-app (role admin) */
  const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all();
  admins.forEach((a) => notify(a.id, 'In-App', `New incident ${id} (${category}) reported by ${p.name}${booking ? ' on booking ' + booking.id : ''}.`));
  return out(get(id));
}

/* Admin triage. Each transition validates the source state and required text. */
function triage(actorUserId, id, { status, notes, resolution, reason }) {
  const row = get(id);
  if (!row) throw notFound('Incident not found');
  if (!STATUSES.includes(status)) throw bad('Unknown incident status');
  const from = row.status;
  if (CLOSED.includes(from)) throw conflict('Incident already ' + from + ' — the audit trail keeps the history');
  if (status === 'UNDER_REVIEW' && !String(notes || '').trim()) throw bad('Say what is being reviewed (admin note required)');
  if (status === 'RESOLVED' && !String(resolution || '').trim()) throw bad('A resolution is required — the pandit will see it');
  if (status === 'DISMISSED' && !String(reason || '').trim()) throw bad('A dismissal reason is required');
  tx(() => {
    db.prepare('UPDATE incidents SET status=?, admin_notes=?, resolution=?, resolved_at=? WHERE id=?')
      .run(status,
        notes !== undefined ? String(notes).slice(0, 1000) : row.admin_notes,
        status === 'RESOLVED' ? String(resolution).slice(0, 1000) : row.resolution,
        status === 'RESOLVED' ? Date.now() : row.resolved_at, id);
  })();
  const detail = { from, to: status };
  if (notes !== undefined) detail.notes = String(notes).slice(0, 200);
  if (status === 'RESOLVED') detail.resolution = String(resolution).slice(0, 200);
  if (status === 'DISMISSED') detail.reason = String(reason).slice(0, 200);
  audit(actorUserId, 'incident.triage', 'incident', id, detail,
    { oldValue: { status: from }, newValue: { status } });
  const p = db.prepare('SELECT user_id FROM pandits WHERE id=?').get(row.pandit_id);
  if (p && p.user_id) {
    const msg = status === 'UNDER_REVIEW' ? `Your incident ${id} is under review.`
      : status === 'RESOLVED' ? `Your incident ${id} is resolved: ${String(resolution).slice(0, 160)}`
      : `Your incident ${id} was reviewed and not actionable: ${String(reason).slice(0, 160)}`;
    notify(p.user_id, 'In-App', msg);
  }
  return out(get(id));
}

module.exports = { CATEGORIES, STATUSES, get, list, forPandit, counts, report, triage, out };
