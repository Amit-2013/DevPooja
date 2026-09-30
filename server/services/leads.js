/* Phase 26 — Leads CRM: the ONE writer for the leads table (master-prompt
   Phase 26). A lead is a prospective customer captured from a public enquiry
   (contact / corporate / astrology / kundli forms), the pandit partner form or
   manual admin entry; the pipeline NEW → CONTACTED → QUALIFIED → CONVERTED |
   LOST is what turns enquiries into bookings. `type` doubles as the capture
   SOURCE (the legacy rows only ever came from the four enquiry forms) — the
   master plan maps type → source. Mirrors app/services/leads.py. */
'use strict';
const { db, nextSeq } = require('../db');
const { v, bad, notFound, conflict } = require('../lib/util');

const SOURCES = ['Contact', 'Corporate', 'Astrology', 'Kundli', 'Partner', 'Walk-in', 'Other'];
const STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST'];
const LIVE = ['NEW', 'CONTACTED', 'QUALIFIED'];

const out = (l) => l && ({
  id: l.id, type: l.type, name: l.name, details: l.details || '', date: l.date,
  mobile: l.mobile || '', email: l.email || '', service: l.service || '',
  location: l.location || '', assignedTo: l.assigned_to || null,
  status: l.status, followUpAt: l.follow_up_at || null,
  convertedBookingId: l.converted_booking_id || null
});

/* Shared capture validator — the public route and the admin manual path both
   go through here so nothing can bypass the rules. */
function captureInput(body, { public: isPublic } = {}) {
  const src = isPublic
    ? v.oneOf(body.source || body.type, ['Contact', 'Corporate', 'Astrology', 'Kundli'], 'Source')
    : v.oneOf(body.source || body.type, SOURCES, 'Source');
  const mobile = body.mobile == null || body.mobile === '' ? '' : v.mobile(body.mobile);
  const email = body.email == null || body.email === '' ? '' : v.email(body.email);
  /* Contact channels are optional at capture (the kundli form never had one)
     but VALIDATED when present; reachability is enforced at conversion time. */
  return {
    source: src,
    name: v.str(body.name, 'Name', { max: 120 }),
    mobile, email,
    service: String(body.service || '').trim().slice(0, 120),
    location: String(body.location || '').trim().slice(0, 120),
    notes: String(body.notes || body.details || '').trim().slice(0, 800)
  };
}

/* Public/admin capture. Returns the created lead. */
function capture(body, actor, ip) {
  const i = captureInput(body, { public: !actor });
  const ins = db.prepare(`INSERT INTO leads(type,name,details,date,mobile,email,service,location,status)
    VALUES(?,?,?,?,?,?,?,?,'NEW')`);
  const r = ins.run(i.source, i.name, i.notes, new Date().toISOString().slice(0, 10),
    i.mobile, i.email, i.service, i.location);
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(r.lastInsertRowid);
  require('../lib/audit').audit(actor || null, 'lead.captured', 'lead', lead.id,
    { source: lead.type, name: lead.name, hasContact: !!(lead.mobile || lead.email) },
    actor ? undefined : { role: 'public', ip });
  return out(lead);
}

/* Admin list with filters: ?status (exact or comma-list), ?q (name/mobile/
   email/notes/id LIKE, % and _ stripped), ?source, ?assigned=me|adminUserId,
   ?from/?to (YYYY-MM-DD on the capture date), ?followup=1 (due: live rows with
   follow_up_at set and past). Newest first. */
function list(f = {}) {
  const w = [], a = [];
  const statuses = String(f.status || '').split(',').map((s) => s.trim()).filter((s) => STATUSES.includes(s));
  if (statuses.length) { w.push(`status IN (${statuses.map(() => '?').join(',')})`); a.push(...statuses); }
  if (f.source && SOURCES.includes(f.source)) { w.push('type=?'); a.push(f.source); }
  if (f.assigned === 'me' || f.assigned) { w.push('assigned_to=?'); a.push(f.assigned === 'me' ? (f.actor || '') : f.assigned); }
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) { w.push('date>=?'); a.push(f.from); }
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) { w.push('date<=?'); a.push(f.to); }
  if (f.followup) { w.push("follow_up_at IS NOT NULL AND follow_up_at<=? AND status IN ('NEW','CONTACTED','QUALIFIED')"); a.push(Date.now()); }
  if (f.q) {
    const q = String(f.q).replace(/[%_]/g, '').trim();
    if (q) { w.push("(name LIKE ? OR mobile LIKE ? OR email LIKE ? OR details LIKE ? OR CAST(id AS TEXT)=?)"); a.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, q); }
  }
  const rows = db.prepare(`SELECT * FROM leads ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`).all(...a);
  const counts = { NEW: 0, CONTACTED: 0, QUALIFIED: 0, CONVERTED: 0, LOST: 0 };
  db.prepare('SELECT status, COUNT(*) n FROM leads GROUP BY status').all().forEach((r) => { counts[r.status] = r.n; });
  return { leads: rows.map(out), counts };
}

const one = (id) => { const l = db.prepare('SELECT * FROM leads WHERE id=?').get(id); if (!l) throw notFound('Lead not found'); return l; };

/* Lifecycle move. CONVERTED is terminal-with-conversion: only via convert().
   LOST keeps the door open (a lost lead can be re-qualified while it is still
   an enquiry — the reason is required and audited). */
function setStatus(id, status, reason, actor) {
  const l = one(id);
  if (!STATUSES.includes(status)) throw bad('Status is invalid');
  if (l.status === 'CONVERTED') throw conflict('A converted lead is closed — the booking carries the history');
  if (l.status === status) return out(l);
  if (status === 'LOST' && !String(reason || '').trim()) throw bad('A reason is required to mark a lead lost');
  db.prepare('UPDATE leads SET status=? WHERE id=?').run(status, l.id);
  require('../lib/audit').audit(actor, 'lead.status', 'lead', l.id,
    { from: l.status, to: status }, { reason: status === 'LOST' ? String(reason).slice(0, 300) : (reason || undefined) });
  return out({ ...l, status });
}

function assign(id, userId, actor) {
  const l = one(id);
  if (userId && !db.prepare("SELECT id FROM users WHERE id=?").get(userId)) throw bad('Unknown assignee');
  db.prepare('UPDATE leads SET assigned_to=? WHERE id=?').run(userId || null, l.id);
  require('../lib/audit').audit(actor, 'lead.assign', 'lead', l.id,
    { from: l.assigned_to, to: userId || null });
  return out({ ...l, assigned_to: userId || null });
}

function scheduleFollowUp(id, whenMs, actor) {
  const l = one(id);
  const t = v.int(whenMs, 'Follow-up time', { min: 0, max: Date.now() + 366 * 86400000 });
  db.prepare('UPDATE leads SET follow_up_at=? WHERE id=?').run(t, l.id);
  require('../lib/audit').audit(actor, 'lead.followup', 'lead', l.id,
    { from: l.follow_up_at, to: t });
  return out({ ...l, follow_up_at: t });
}

function updateNotes(id, notes, actor) {
  const l = one(id);
  const n = v.str(notes, 'Notes', { max: 800 });
  db.prepare('UPDATE leads SET details=? WHERE id=?').run(n, l.id);
  require('../lib/audit').audit(actor, 'lead.notes', 'lead', l.id, { from: (l.details || '').slice(0, 80), to: n.slice(0, 80) });
  return out({ ...l, details: n });
}

/* The money move: a lead becomes a real manual booking via the EXISTING
   bookings engine (adminManual — creates/finds the customer by mobile,
   prices through shared pricing). The lead closes as CONVERTED and keeps the
   booking id. Works for leads without contact details only if they already
   carry a mobile; adminManual requires one. */
function convert(id, body, actor) {
  const l = one(id);
  if (l.status === 'CONVERTED') throw conflict('Lead already converted');
  if (!l.mobile) throw bad('Add a mobile number to the lead before converting it to a booking');
  const booking = require('./bookings').adminManual({
    name: l.name, mobile: l.mobile, mode: (body && body.mode) || 'home',
    slot: (body && body.slot) || '10:00 AM', date: (body && body.date) || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    pujaId: (body && body.pujaId) || 'satyanarayan', city: l.location || undefined
  });
  db.prepare("UPDATE leads SET status='CONVERTED', converted_booking_id=? WHERE id=?").run(booking.id, l.id);
  require('../lib/audit').audit(actor, 'lead.converted', 'lead', l.id,
    { from: l.status, to: 'CONVERTED', bookingId: booking.id });
  return { lead: out({ ...l, status: 'CONVERTED', converted_booking_id: booking.id }), bookingId: booking.id };
}

function remove(id, actor) {
  const l = one(id);
  if (LIVE.includes(l.status)) throw conflict('Live leads are never deleted — mark them LOST with a reason instead');
  db.prepare('DELETE FROM leads WHERE id=?').run(l.id);
  require('../lib/audit').audit(actor, 'lead.deleted', 'lead', l.id, { status: l.status });
  return { ok: true };
}

module.exports = { SOURCES, STATUSES, LIVE, out, captureInput, capture, list, setStatus, assign, scheduleFollowUp, updateNotes, convert, remove };
