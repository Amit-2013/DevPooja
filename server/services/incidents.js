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
  reportedAt: r.reported_at, resolvedAt: r.resolved_at,
  /* Phase 20 follow-up (migration 018): dismissed incidents can be reopened */
  reopenCount: r.reopen_count || 0, reopenReason: r.reopen_reason || ''
});

function list({ status } = {}) {
  const rows = status && STATUSES.includes(status)
    ? db.prepare('SELECT * FROM incidents WHERE status=? ORDER BY reported_at DESC, id DESC').all(status)
    : db.prepare('SELECT * FROM incidents ORDER BY reported_at DESC, id DESC').all();
  return rows.map(out);
}
/* Admin in-app notifications for the review queue. Reuses the standard notifs
   store (the In-App channel) filtered to queue-entry alerts for this incident. */
function adminQueueAlerts(id) {
  return db.prepare("SELECT id, user_id, channel, message, ts FROM notifs WHERE channel='In-App' AND message LIKE ? ORDER BY ts DESC, id DESC LIMIT 50")
    .all(`Repeat-reopen alert: incident ${id} is on the review queue (%`).map((n) => ({ id: n.id, userId: n.user_id, channel: n.channel, message: n.message, ts: n.ts }));
}
/* All queue-entry alerts across every incident (Operations notifications panel). */
function allQueueAlerts() {
  return db.prepare("SELECT id, user_id, channel, message, ts FROM notifs WHERE channel='In-App' AND message LIKE 'Repeat-reopen alert: incident %' ORDER BY ts DESC, id DESC LIMIT 100")
    .all().map((n) => ({ id: n.id, userId: n.user_id, channel: n.channel, message: n.message, ts: n.ts }));
}
function forPandit(panditId) {
  return db.prepare('SELECT * FROM incidents WHERE pandit_id=? ORDER BY reported_at DESC, id DESC').all(panditId).map(out);
}
const REOPEN_LIMIT = 2;
/* Repeat-reopen review queue: an incident dismissed-and-reopened more than
   REOPEN_LIMIT times is a systemic signal (recurring safety/cconduct issue,
   disputed dismissals) that one-off triage keeps losing. Surfaces the live
   queue — anything still OPEN/UNDER_REVIEW — on the Operations tab.

   Per-pandit flagging: a pandit whose reopen-count over the digest window
   exceeds the threshold across DISTINCT bookings (reopens on the same booking
   collapse to one) is a repeated-pattern signal that outlives any single
   incident — surfaced as flaggedPandits so operations can review the pandit,
   not just the incident. */
function flaggedPandits(limit) {
  const cap = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : REOPEN_LIMIT;
  /* cap is a validated integer (Math.floor, >= 1) — safe to inline as a literal:
     binding BOTH the WHERE and HAVING params trips a better-sqlite3/SQLite edge
     case that silently returns an empty set. The per-pandit window is every live
     reopened incident (reopen_count > 0); the threshold applies to DISTINCT
     bookings in HAVING, so a single-booking reopen loop never flags on volume. */
  const rows = db.prepare(`SELECT i.pandit_id, p.name AS pandit_name,
    SUM(i.reopen_count) AS reopens, COUNT(DISTINCT i.booking_id) AS bookings,
    COUNT(*) AS incidents, MAX(i.reported_at) AS latest
    FROM incidents i LEFT JOIN pandits p ON p.id=i.pandit_id
    WHERE i.reopen_count > 0 AND i.status IN ('OPEN','UNDER_REVIEW')
    GROUP BY i.pandit_id HAVING COUNT(DISTINCT i.booking_id) > ${cap}
    ORDER BY reopens DESC, pandit_id`).all();
  return rows.map((r) => ({
    panditId: r.pandit_id, pandit: r.pandit_name || '', reopens: r.reopens || 0,
    bookings: r.bookings || 0, incidents: r.incidents || 0, latest: r.latest || null
  }));
}
function reopenDigest(limit) {
  const cap = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : REOPEN_LIMIT;
  const rows = db.prepare('SELECT * FROM incidents WHERE reopen_count > ? ORDER BY reopen_count DESC, reported_at DESC, id DESC').all(cap);
  return { incidents: rows.map(out), flaggedPandits: flaggedPandits(cap), flaggedCustomers: flaggedCustomers(cap) };
}
/* Customer-conduct mirror of the per-pandit flag: a customer whose bookings
   accumulate repeated reopened incidents across DISTINCT bookings is the
   demand-side pattern signal (the incidents table links the customer from
   the booking at report time). Same aggregation as flaggedPandits, grouped
   by customer_id; rows without a booking (customer_id IS NULL) can never
   accumulate distinct bookings and are excluded up front. */
function flaggedCustomers(limit) {
  const cap = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : REOPEN_LIMIT;
  /* cap is a validated integer — inlined as a literal (same SQLite WHERE+HAVING
     bound-param edge case as flaggedPandits). */
  const rows = db.prepare(`SELECT i.customer_id AS customer_id, u.name AS customer_name,
    SUM(i.reopen_count) AS reopens, COUNT(DISTINCT i.booking_id) AS bookings,
    COUNT(*) AS incidents, MAX(i.reported_at) AS latest
    FROM incidents i LEFT JOIN users u ON u.id=i.customer_id
    WHERE i.customer_id IS NOT NULL AND i.reopen_count > 0 AND i.status IN ('OPEN','UNDER_REVIEW')
    GROUP BY i.customer_id HAVING COUNT(DISTINCT i.booking_id) > ${cap}
    ORDER BY reopens DESC, customer_id`).all();
  return rows.map((r) => ({
    customerId: r.customer_id, customer: r.customer_name || '', reopens: r.reopens || 0,
    bookings: r.bookings || 0, incidents: r.incidents || 0, latest: r.latest || null
  }));
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

/* Phase 20 follow-up: reopen a DISMISSED incident. RESOLVED stays final — a
   resolution recorded to the pandit is a committed outcome. The reopen reason
   is mandatory (it is the new audit's core fact), the incident returns to
   UNDER_REVIEW so the normal triage loop applies, and the trail keeps every
   hop: the dismissal audit stays, the reopen adds its own entry. */
function reopen(actorUserId, id, { reason } = {}) {
  const row = get(id);
  if (!row) throw notFound('Incident not found');
  if (row.status !== 'DISMISSED') throw bad('Only dismissed incidents can be reopened');
  const why = String(reason || '').trim();
  if (!why) throw bad('A reopening reason is required');
  tx(() => {
    db.prepare('UPDATE incidents SET status=?, reopen_count=reopen_count+1, reopen_reason=? WHERE id=?')
      .run('UNDER_REVIEW', why.slice(0, 1000), id);
  })();
  audit(actorUserId, 'incident.reopened', 'incident', id,
    { from: 'DISMISSED', to: 'UNDER_REVIEW', reason: why.slice(0, 200) },
    { oldValue: { status: 'DISMISSED' }, newValue: { status: 'UNDER_REVIEW' } });
  const p = db.prepare('SELECT user_id FROM pandits WHERE id=?').get(row.pandit_id);
  if (p && p.user_id) notify(p.user_id, 'In-App', `Your incident ${id} was reopened for review: ${why.slice(0, 160)}`);
  /* Queue-entry alert: a reopen that pushes the count above REOPEN_LIMIT puts
     the incident on the Operations review queue — tell every admin through the
     same in-app channel used for new incident reports. Every reopen above the
     threshold follows a dismissal, so each alert is a fresh queue entry. */
  const fresh = get(id);
  if (fresh.reopen_count > REOPEN_LIMIT) {
    const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all();
    admins.forEach((a) => notify(a.id, 'In-App',
      `Repeat-reopen alert: incident ${id} is on the review queue (${fresh.reopen_count} reopens, threshold ${REOPEN_LIMIT}). Latest reason: ${why.slice(0, 140)}`));
  }
  return out(get(id));
}

/* Pandit ids currently flagged by the digest — feeds the booking review-hold
   (services/reviewHold.js) and the pandit-module surfacing. */
function flaggedPanditIds(limit) {
  return flaggedPandits(limit).map((x) => x.panditId);
}
module.exports = { CATEGORIES, STATUSES, get, list, adminQueueAlerts, allQueueAlerts, flaggedPandits, flaggedPanditIds, flaggedCustomers, forPandit, counts, report, triage, reopen, reopenDigest, REOPEN_LIMIT, out };
