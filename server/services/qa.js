/* QA & rating engine (master plan Phase 17) + the derived profile metrics for
   Phase 5's profile enrichment, on top of migration 016's qa_records table.

   Design:
   - qa_records: one scored observation per booking, written by an admin.
     Dimension vocabulary mirrors 014's trial_poojas (same 7 axes, 1..5).
   - overall is computed as the mean of the supplied dimensions (server-side,
     never trusted from the client) and stored for cheap listing.
   - pandits.qa_score is a cached average over all of a pandit's records,
     refreshed on every write. Reviews (customers) keep driving pandits.rating
     unchanged — QA score is the internal quality signal, rating is public.
   - cancellation%/no-show% are DERIVED from bookings on read, never stored:
     cancelled-while-assigned = this pandit was assigned when the booking was
     cancelled (by customer or admin); no-show proxy = past scheduled date,
     was assigned, never Started nor Completed. Percentages use a booked
     denominator (assigned bookings incl. cancelled), 0 when nothing booked.
*/
'use strict';
const { db, tx } = require('../db');
const { bad, notFound, rid } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('./notify');

const DIMENSIONS = ['punctuality', 'communication', 'ritual_compliance', 'presentation', 'customer_interaction', 'digital_capability', 'documentation'];

const get = (id) => db.prepare('SELECT * FROM qa_records WHERE id=?').get(id);
const forPandit = (pid) => db.prepare('SELECT * FROM qa_records WHERE pandit_id=? ORDER BY created_at DESC LIMIT 200').all(pid);
const list = () => db.prepare(`SELECT q.*, p.name pandit_name FROM qa_records q LEFT JOIN pandits p ON p.id=q.pandit_id ORDER BY q.created_at DESC LIMIT 300`).all();

/* Phase 5 derived metrics: booked = ever assigned to this pandit (incl. cancelled). */
function derived(panditId) {
  const assigned = db.prepare("SELECT COUNT(*) c FROM bookings WHERE pandit_id=? AND status NOT IN ('PendingPayment')").get(panditId).c;
  const cancWhileAssigned = db.prepare("SELECT COUNT(*) c FROM bookings WHERE pandit_id=? AND status='Cancelled'").get(panditId).c;
  const noShow = db.prepare(`SELECT COUNT(*) c FROM bookings WHERE pandit_id=? AND date < ?
    AND status NOT IN ('Completed','Cancelled','PendingPayment')`).get(panditId, new Date().toISOString().slice(0, 10)).c;
  const pct = (n) => assigned ? Math.round(100 * n / assigned) : 0;
  return { assigned, cancelledWhileAssigned: cancWhileAssigned, noShows: noShow, cancelPct: pct(cancWhileAssigned), noShowPct: pct(noShow) };
}

function refreshScore(panditId) {
  const avg = db.prepare('SELECT AVG(overall) a, COUNT(*) c FROM qa_records WHERE pandit_id=? AND overall IS NOT NULL').get(panditId);
  db.prepare('UPDATE pandits SET qa_score=? WHERE id=?').run(avg.c ? Math.round(avg.a * 10) / 10 : null, panditId);
  return avg.c ? Math.round(avg.a * 10) / 10 : null;
}

/* Create a QA record. All-or-nothing on dimensions: none given is refused,
   unknown dimensions are refused, values must be 1..5. Audited; the pandit is
   notified with the overall score (never the raw notes unless an admin shares). */
function create({ evaluator, panditId, bookingId, dims, notes }) {
  const p = db.prepare('SELECT * FROM pandits WHERE id=?').get(panditId);
  if (!p) throw notFound('Pandit not found');
  let booking = null;
  if (bookingId) {
    booking = db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
    if (!booking) throw notFound('Booking not found');
    if (booking.pandit_id !== panditId) throw bad('The booking belongs to a different pandit');
  }
  const given = {};
  for (const k of DIMENSIONS) {
    const val = dims ? dims[k] : undefined;
    if (val === undefined || val === null || val === '') continue;
    const n = Number(val);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw bad(`${k} must be an integer 1..5`);
    given[k] = n;
  }
  if (!Object.keys(given).length) throw bad('Score at least one dimension (1..5)');
  const overall = Math.round(Object.values(given).reduce((s, n) => s + n, 0) / Object.values(given).length * 10) / 10;
  const id = 'qa' + rid(6);
  tx(() => {
    db.prepare(`INSERT INTO qa_records(id,pandit_id,booking_id,evaluator,punctuality,communication,ritual_compliance,
      presentation,customer_interaction,digital_capability,documentation,overall,notes,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, panditId, booking ? bookingId : null, evaluator,
        given.punctuality ?? null, given.communication ?? null, given.ritual_compliance ?? null,
        given.presentation ?? null, given.customer_interaction ?? null, given.digital_capability ?? null,
        given.documentation ?? null, overall, notes ? String(notes).slice(0, 500) : null, Date.now());
    db.prepare('UPDATE pandits SET qa_score=? WHERE id=?').run(refreshScore(panditId), panditId);
  })();
  audit(evaluator, 'qa.recorded', 'pandit', panditId,
    { qaId: id, bookingId: booking ? bookingId : null, dims: given, overall },
    { newValue: { overall, ...given } });
  if (p.user_id) notify(p.user_id, 'In-App', `A service-quality review was recorded: ${overall}/5 overall.`);
  return out(get(id));
}

function remove({ id, uid, reason }) {
  const row = get(id);
  if (!row) throw notFound('QA record not found');
  tx(() => {
    db.prepare('DELETE FROM qa_records WHERE id=?').run(id);
    db.prepare('UPDATE pandits SET qa_score=? WHERE id=?').run(refreshScore(row.pandit_id), row.pandit_id);
  })();
  audit(uid, 'qa.deleted', 'pandit', row.pandit_id, { qaId: id, overall: row.overall },
    { reason, oldValue: { overall: row.overall } });
  return { ok: true };
}

const out = (r) => r && ({
  id: r.id, panditId: r.pandit_id, panditName: r.pandit_name || null, bookingId: r.booking_id,
  evaluator: r.evaluator, dims: {
    punctuality: r.punctuality, communication: r.communication, ritualCompliance: r.ritual_compliance,
    presentation: r.presentation, customerInteraction: r.customer_interaction,
    digitalCapability: r.digital_capability, documentation: r.documentation
  }, overall: r.overall, notes: r.notes || '', createdAt: r.created_at
});

module.exports = { DIMENSIONS, get, forPandit, list, derived, refreshScore, create, remove, out };
