/* Per-document KYC management (master plan Phase 4) — activates the
   kyc_documents table scaffolded by migration 014 on top of the existing
   pandits.kyc JSON + pandit.status approve/reject flow, which stay untouched.

   Status vocabulary (master spec):
     PENDING -> UNDER_REVIEW -> VERIFIED | REJECTED
        ^-------------- REVERIFICATION_REQUIRED (admin requests re-upload)
     VERIFIED -> EXPIRED (date sweep or admin) -> REVERIFICATION_REQUIRED
   A "request re-upload" is REVERIFICATION_REQUIRED + a new PENDING row when the
   pandit re-uploads; every decision is audited with old/new values + reason.

   The account-level link stays as it was: pandit.status (pending/verified/…)
   drives booking eligibility and the payout engine's KYC auto-hold; doc status
   feeds the admin KYC screen and the expiry reminders below. */
'use strict';
const { db } = require('../db');
const { bad, conflict, notFound, rid } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('./notify');

const STATUSES = ['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED', 'REVERIFICATION_REQUIRED'];
const DOC_TYPES = ['AADHAAR', 'PAN', 'ADDRESS_PROOF', 'PHOTOGRAPH', 'QUALIFICATION', 'TRAINING', 'OTHER'];
const OPEN_STATUSES = ['PENDING', 'UNDER_REVIEW', 'REVERIFICATION_REQUIRED'];
const REMIND_AHEAD_DAYS = 30;

const get = (id) => db.prepare('SELECT * FROM kyc_documents WHERE id=?').get(id);
const forPandit = (pid) => db.prepare('SELECT * FROM kyc_documents WHERE pandit_id=? ORDER BY uploaded_at DESC').all(pid);

function docType(t) { return DOC_TYPES.includes(t) ? t : null; }

/* Pandit upload: creates a PENDING row (and supersedes any open row of the same
   type, keeping history). Magic-byte/type checks already ran in multer+verifyMagic. */
function upload({ pid, uid, docType: dt, fileName, originalName }) {
  if (!docType(dt)) throw bad('Unknown document type');
  if (!fileName) throw bad('Attach the document file');
  const prior = db.prepare(
    "SELECT id FROM kyc_documents WHERE pandit_id=? AND doc_type=? AND status IN ('PENDING','UNDER_REVIEW','REVERIFICATION_REQUIRED')")
    .get(pid, dt);
  if (prior) {
    db.prepare("UPDATE kyc_documents SET status='SUPERSEDED' WHERE id=?").run(prior.id);
    audit(uid, 'kyc.superseded', 'kyc_document', prior.id, { docType: dt, replacedBy: null });
  }
  const id = 'kyc' + rid(6);
  db.prepare(`INSERT INTO kyc_documents(id,pandit_id,doc_type,file_name,status,uploaded_at)
    VALUES(?,?,?,?, 'PENDING', ?)`).run(id, pid, dt, fileName, Date.now());
  audit(uid, 'kyc.upload', 'kyc_document', id, { docType: dt, originalName: String(originalName || '').slice(0, 120) });
  return get(id);
}

/* Admin decision transitions. VERIFIED may carry an expiry; REJECTED and
   REVERIFICATION_REQUIRED require a reason (the pandit sees it). */
function decide({ id, uid, status, reason, expiresAt, reverifyAt }) {
  const row = get(id);
  if (!row) throw notFound('KYC document not found');
  if (!STATUSES.includes(status)) throw bad('Unknown KYC status');
  const current = row.status;
  if (['VERIFIED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'].includes(current)) {
    if (status !== 'REVERIFICATION_REQUIRED' && status !== 'VERIFIED') throw conflict('Document already ' + current);
  }
  if (status === 'REJECTED' && !reason) throw bad('A rejection reason is required — the pandit must see WHY');
  if (status === 'REVERIFICATION_REQUIRED' && !reason) throw bad('Say what must be re-uploaded and why');
  db.prepare(`UPDATE kyc_documents SET status=?, verified_by=?, verified_at=?, reject_reason=?,
    expires_at=?, next_reverification_at=? WHERE id=?`)
    .run(status, uid, Date.now(),
         status === 'REJECTED' || status === 'REVERIFICATION_REQUIRED' ? String(reason).slice(0, 300) : null,
         status === 'VERIFIED' && expiresAt ? Number(expiresAt) : null,
         status === 'VERIFIED' && reverifyAt ? Number(reverifyAt) : null, id);
  audit(uid, 'kyc.decide', 'kyc_document', id,
    { docType: row.doc_type, from: current, to: status, ...(reason ? { reason } : {}) },
    { reason: reason || undefined, oldValue: { status: current }, newValue: { status } });
  const p = db.prepare('SELECT user_id FROM pandits WHERE id=?').get(row.pandit_id);
  if (p) notify(p.user_id, 'In-App', `Your ${row.doc_type} document is ${status.toLowerCase().replace(/_/g, ' ')}` + (reason ? `: ${reason}` : ''));
  return get(id);
}

/* Expiry sweep: flips VERIFIED docs past their expiry to EXPIRED and notifies.
   Called opportunistically on admin KYC reads (cheap, idempotent). */
function sweep() {
  const now = Date.now();
  const stale = db.prepare("SELECT * FROM kyc_documents WHERE status='VERIFIED' AND expires_at IS NOT NULL AND expires_at < ?").all(now);
  for (const row of stale) {
    db.prepare("UPDATE kyc_documents SET status='EXPIRED' WHERE id=?").run(row.id);
    audit(null, 'kyc.auto_expire', 'kyc_document', row.id, { docType: row.doc_type, panditId: row.pandit_id });
    const p = db.prepare('SELECT user_id FROM pandits WHERE id=?').get(row.pandit_id);
    if (p) notify(p.user_id, 'In-App', `Your ${row.doc_type} document has expired. Please upload a fresh copy.`);
  }
  return stale.length;
}

/* Admin KYC screen summary (master spec columns) + reminder list. */
function summary() {
  sweep();
  const ahead = Date.now() + REMIND_AHEAD_DAYS * 86400000;
  const docs = db.prepare(`SELECT k.*, p.name AS pandit_name, p.status AS pandit_status FROM kyc_documents k
    LEFT JOIN pandits p ON p.id = k.pandit_id ORDER BY k.uploaded_at DESC LIMIT 500`).all();
  const reminders = db.prepare(`SELECT k.*, p.name AS pandit_name FROM kyc_documents k
    LEFT JOIN pandits p ON p.id = k.pandit_id
    WHERE (k.status='VERIFIED' AND k.expires_at IS NOT NULL AND k.expires_at < ?)
       OR (k.status='VERIFIED' AND k.next_reverification_at IS NOT NULL AND k.next_reverification_at < ?)
       OR k.status='EXPIRED' OR k.status='REVERIFICATION_REQUIRED'
    ORDER BY k.uploaded_at DESC`).all(ahead, ahead);
  const counts = STATUSES.reduce((m, s) => (m[s] = docs.filter((d) => d.status === s).length, m), {});
  return { docs: docs.map(out), reminders: reminders.map(out), counts, STATUSES, DOC_TYPES };
}

const out = (r) => ({
  id: r.id, panditId: r.pandit_id, panditName: r.pandit_name || null, docType: r.doc_type,
  fileName: r.file_name, status: r.status, uploadedAt: r.uploaded_at,
  verifiedBy: r.verified_by, verifiedAt: r.verified_at, rejectReason: r.reject_reason || null,
  expiresAt: r.expires_at || null, nextReverificationAt: r.next_reverification_at || null
});

module.exports = { STATUSES, DOC_TYPES, OPEN_STATUSES, REMIND_AHEAD_DAYS,
                   get, forPandit, upload, decide, sweep, summary, out };
