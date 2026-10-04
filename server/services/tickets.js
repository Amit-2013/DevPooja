/* Phase 19 — complaints workflow: ONE state machine for tickets, mirrored by
   backend-python/app/services/tickets.py.

   Statuses: OPEN → UNDER_REVIEW → PANDIT_RESPONSE → CUSTOMER_RESPONSE →
   DECISION → RESOLVED. The admin drives explicit transitions (DECISION and
   RESOLVED require the written note, stored as tickets.resolution); a pandit
   reply moves the ticket to PANDIT_RESPONSE and a customer reply to
   CUSTOMER_RESPONSE on their own; RESOLVED only reopens through an explicit
   admin transition (UNDER_REVIEW) — replies on a resolved ticket are refused
   with guidance. Every reply lands in ticket_messages with optional evidence
   attachments that must be /media/ urls from the magic-checked upload
   endpoint; anything else is filtered out. Legacy rows carrying 'Open' or
   'Resolved' normalise through norm() until migration 034 has backfilled them. */
'use strict';
const { db, nextSeq } = require('../db');
const { v, bad, notFound, conflict, j } = require('../lib/util');

const STATUSES = ['OPEN', 'UNDER_REVIEW', 'PANDIT_RESPONSE', 'CUSTOMER_RESPONSE', 'DECISION', 'RESOLVED'];
const ALLOWED = {
  OPEN: ['UNDER_REVIEW', 'PANDIT_RESPONSE', 'CUSTOMER_RESPONSE', 'RESOLVED'],
  UNDER_REVIEW: ['PANDIT_RESPONSE', 'CUSTOMER_RESPONSE', 'DECISION', 'RESOLVED'],
  PANDIT_RESPONSE: ['CUSTOMER_RESPONSE', 'DECISION', 'UNDER_REVIEW', 'RESOLVED'],
  CUSTOMER_RESPONSE: ['PANDIT_RESPONSE', 'UNDER_REVIEW', 'DECISION', 'RESOLVED'],
  DECISION: ['RESOLVED', 'UNDER_REVIEW', 'CUSTOMER_RESPONSE'],
  RESOLVED: ['UNDER_REVIEW'] /* admin reopens for further review */
};
const NOTE_REQUIRED = ['DECISION', 'RESOLVED'];

/* Legacy vocabulary lives in pre-034 rows and in old snapshots. */
const norm = (s) => (s === 'Open' ? 'OPEN' : s === 'Resolved' ? 'RESOLVED' : (STATUSES.includes(s) ? s : 'OPEN'));

const one = (id) => db.prepare('SELECT * FROM tickets WHERE id=?').get(id);

/* The state-payload ticket shape — serialize.js delegates here so the SPA, the
   detail endpoint and the pandit list all speak the same words. */
function out(t) {
  return t && {
    id: t.id, userId: t.user_id, b: t.booking_id || '', t: t.text,
    st: norm(t.status), prio: t.prio, res: t.resolution || null, up: t.updated_at || null
  };
}

/* Evidence attachments: only urls the magic-checked upload endpoint returned. */
function attachList(a) {
  return (Array.isArray(a) ? a : [])
    .map((x) => String(x)).filter((x) => x.startsWith('/media/') && x.length <= 200).slice(0, 8);
}

function addMessage(ticketId, authorId, role, message, attachments) {
  const id = 'TM' + nextSeq('ticket_msg_seq', 5);
  const now = Date.now();
  db.prepare(`INSERT INTO ticket_messages(id,ticket_id,author_id,author_role,message,attachments,created)
    VALUES(?,?,?,?,?,?,?)`).run(id, ticketId, authorId, role, message, JSON.stringify(attachments), now);
  db.prepare('UPDATE tickets SET updated_at=? WHERE id=?').run(now, ticketId);
  return { id, authorId, role, message, attachments, created: now };
}

/* Ticket + thread with author names (the detail both portals render). `next`
   is the legal transition set for the current status — the FE renders exactly
   those buttons instead of duplicating the state machine. */
function detail(id) {
  const t = one(id);
  if (!t) throw notFound('Ticket not found');
  const messages = db.prepare(`SELECT m.*, u.name author FROM ticket_messages m
    LEFT JOIN users u ON u.id=m.author_id WHERE m.ticket_id=? ORDER BY m.created, m.rowid`).all(id)
    .map((m) => ({
      id: m.id, authorId: m.author_id, author: m.author || m.author_id, role: m.author_role,
      message: m.message, attachments: j(m.attachments, []), created: m.created
    }));
  return { ticket: { ...out(t), next: ALLOWED[norm(t.status)] || [] }, messages };
}

/* A reply. The role decides the status move; RESOLVED is closed for business
   (replies refused with the guidance a customer can act on). */
function reply(id, actor, role, body) {
  const t = one(id);
  if (!t) throw notFound('Ticket not found');
  const st = norm(t.status);
  if (st === 'RESOLVED') throw conflict('This ticket is resolved. Raise a new ticket if the issue returns.');
  const message = v.str((body && body.message) || '', 'Message', { max: 1000 });
  const attachments = attachList(body && body.attachments);

  let target = null;
  if (role === 'customer') {
    if (st === 'OPEN') target = null;                              /* still being triaged: just append */
    else if (['UNDER_REVIEW', 'PANDIT_RESPONSE', 'DECISION'].includes(st)) target = 'CUSTOMER_RESPONSE';
  } else if (role === 'pandit') {
    if (['OPEN', 'UNDER_REVIEW', 'CUSTOMER_RESPONSE'].includes(st)) target = 'PANDIT_RESPONSE';
    else if (st === 'PANDIT_RESPONSE') target = null;               /* follow-up on their own reply */
    else throw conflict('The admin is recording a decision on this complaint — wait for their move.');
  } else if (role === 'admin') {
    if (st === 'OPEN') target = 'UNDER_REVIEW';                    /* an admin note starts the review */
  }
  if (target && !(ALLOWED[st] || []).includes(target)) {
    throw conflict(`Cannot move a ${st} ticket to ${target}`);
  }

  const msg = addMessage(id, actor, role, message, attachments);
  if (target) db.prepare('UPDATE tickets SET status=? WHERE id=?').run(target, id);
  require('../lib/audit').audit(actor, 'ticket.replied', 'ticket', id, { role, status: target || st, attachments: attachments.length });
  return { ticket: out(one(id)), message: msg };
}

/* Explicit admin transition. DECISION/RESOLVED require the written note; the
   note also lands in the thread so both sides see the reasoning. */
function transition(id, actor, body) {
  const t = one(id);
  if (!t) throw notFound('Ticket not found');
  const st = norm(t.status);
  const target = v.oneOf(String((body && body.status) || '').toUpperCase(), STATUSES, 'Status');
  if (target === st) throw conflict(`The ticket is already ${st}`);
  if (!(ALLOWED[st] || []).includes(target)) throw conflict(`Cannot move a ${st} ticket to ${target}`);
  const note = String((body && body.note) || '').trim();
  if (NOTE_REQUIRED.includes(target) && !note) {
    throw bad(target === 'RESOLVED' ? 'A resolution is required to resolve a ticket' : 'A decision note is required');
  }
  if (note) addMessage(id, actor, 'admin', note, []);
  db.prepare('UPDATE tickets SET status=?, resolution=?, updated_at=? WHERE id=?')
    .run(target, NOTE_REQUIRED.includes(target) ? note : (t.resolution || null), Date.now(), id);
  require('../lib/audit').audit(actor, 'ticket.transitioned', 'ticket', id, { from: st, to: target },
    { reason: note || undefined, oldValue: st, newValue: target });
  return out(one(id));
}

/* Pandit scope: only tickets attached to one of their bookings. */
function forPandit(ticket, pid) {
  if (!ticket.b) return false;
  const b = db.prepare('SELECT pandit_id FROM bookings WHERE id=?').get(ticket.b);
  return !!b && b.pandit_id === pid;
}
function listForPandit(pid) {
  return db.prepare(`SELECT t.* FROM tickets t JOIN bookings b ON b.id=t.booking_id
    WHERE b.pandit_id=? ORDER BY COALESCE(t.updated_at, 0) DESC, t.rowid DESC`).all(pid).map(out);
}

module.exports = { STATUSES, ALLOWED, norm, out, attachList, detail, reply, transition, forPandit, listForPandit };
