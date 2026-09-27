/* Pandit agreement management (master plan Phases 23-25) — activates the
   `agreements` + `agreement_acceptances` tables scaffolded by migration 014.

   Model:
   - An agreement is a VERSION ROW, never mutated after publishing. A new draft
     of the same document family gets version = max(version)+1 (Phase 23).
   - `publish` stamps published_at + document_hash = sha256(body): the hash is the
     tamper-evidence link between a version and the acceptance records below it.
   - `archive` is allowed only for versions with NO acceptances — a signed copy is
     never taken out of circulation (archive keeps accepted versions accessible).
   - Acceptance (Phase 24) is version-locked by the migration-014 unique index
     (agreement_id, pandit_id): the same pandit cannot accept the same version
     twice (409), and each acceptance records the verified OTP, method, IP and
     device + an enriched audit record. Accepted versions are immutable.
   - Manual upload (Phase 25): an admin can publish a scanned signed agreement
     (PDF/image) as its own version — method MANUAL, no OTP row is fabricated.

   The OTP itself is issued through the existing public `POST /api/auth/otp/send`
   against the pandit's registered mobile (pandits.mobile) and verified here via
   auth.js verifyOtp — no parallel OTP path is created. Demo OTP = 123456. */
'use strict';
const crypto = require('crypto');
const { db, tx } = require('../db');
const { bad, conflict, notFound, rid } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('./notify');

const STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];
const METHODS = ['DIGITAL', 'MANUAL'];
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

const get = (id) => db.prepare('SELECT * FROM agreements WHERE id=?').get(id);
const acceptances = (agreementId) =>
  db.prepare('SELECT * FROM agreement_acceptances WHERE agreement_id=? ORDER BY accepted_at DESC').all(agreementId);

const out = (r) => ({
  id: r.id, version: r.version, title: r.title, status: r.status,
  documentHash: r.document_hash, fileName: r.file_name, createdBy: r.created_by,
  effectiveFrom: r.effective_from, createdAt: r.created_at,
  publishedAt: r.published_at, archivedAt: r.archived_at,
  body: r.body, acceptanceCount: r.acceptance_count
});

/* Latest published version (the one the pandit portal shows). */
function current() {
  const row = db.prepare("SELECT * FROM agreements WHERE status='PUBLISHED' ORDER BY version DESC LIMIT 1").get();
  if (row) row.acceptance_count = db.prepare('SELECT COUNT(*) c FROM agreement_acceptances WHERE agreement_id=?').get(row.id).c;
  return row ? out(row) : null;
}

/* Admin: create a new draft as the next version of the document family. */
function createDraft({ uid, title, body, effectiveFrom }) {
  if (!String(title || '').trim()) throw bad('A title is required');
  if (!String(body || '').trim()) throw bad('The agreement text is required');
  const next = (db.prepare('SELECT MAX(version) m FROM agreements').get().m || 0) + 1;
  const id = 'agr' + rid(6);
  db.prepare(`INSERT INTO agreements(id,version,title,body,status,created_by,effective_from,created_at)
    VALUES(?,?,?,?,'DRAFT',?,?,?)`)
    .run(id, next, String(title).slice(0, 200), String(body),
         uid || null, effectiveFrom ? String(effectiveFrom).slice(0, 10) : null, Date.now());
  audit(uid, 'agreement.created', 'agreement', id, { version: next, title: String(title).slice(0, 120) });
  return get(id);
}

/* Publish: stamps the published_at timestamp + sha256 document hash. Publishing
   a DRAFT (or a MANUAL row mid-publish) is allowed; ARCHIVED/PUBLISHED is not. */
function publish(id, actorUserId, { reason } = {}) {
  const row = get(id);
  if (!row) throw notFound('Agreement not found');
  if (row.status === 'ARCHIVED') throw conflict('An archived agreement cannot be published again');
  if (row.status === 'PUBLISHED') throw conflict('Agreement is already published');
  const hash = sha256(row.body);
  db.prepare("UPDATE agreements SET status='PUBLISHED', document_hash=?, published_at=? WHERE id=?")
    .run(hash, Date.now(), id);
  audit(actorUserId, 'agreement.published', 'agreement', id,
    { version: row.version, hash }, { reason: reason || undefined, oldValue: { status: row.status }, newValue: { status: 'PUBLISHED', hash } });
  return get(id);
}

/* Archive a version. Refused when acceptances exist — signed copies stay
   accessible; supersede them by publishing a higher version instead. */
function archive(id, actorUserId, { reason } = {}) {
  const row = get(id);
  if (!row) throw notFound('Agreement not found');
  if (row.status === 'ARCHIVED') throw conflict('Agreement is already archived');
  const accepted = db.prepare('SELECT COUNT(*) c FROM agreement_acceptances WHERE agreement_id=?').get(id).c;
  if (accepted > 0) {
    throw conflict(row.version + ' has ' + accepted + ' acceptance(s) — publish a new version instead; accepted versions are never overwritten');
  }
  db.prepare("UPDATE agreements SET status='ARCHIVED', archived_at=? WHERE id=?").run(Date.now(), id);
  audit(actorUserId, 'agreement.archived', 'agreement', id,
    { version: row.version }, { reason: reason || undefined, oldValue: { status: row.status }, newValue: { status: 'ARCHIVED' } });
  return get(id);
}

/* Manual upload (Phase 25): the admin uploads a scanned signed agreement as a
   new version. The row is created PUBLISHED with file_name + document_hash of
   the FILE bytes; acceptance happens offline, so no OTP row is fabricated. */
function manualUpload({ uid, title, fileName, fileBuffer, effectiveFrom }) {
  if (!String(title || '').trim()) throw bad('A title is required');
  if (!fileName) throw bad('Attach the signed agreement file');
  const next = (db.prepare('SELECT MAX(version) m FROM agreements').get().m || 0) + 1;
  const id = 'agr' + rid(6);
  const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  db.prepare(`INSERT INTO agreements(id,version,title,body,status,document_hash,file_name,created_by,effective_from,created_at,published_at)
    VALUES(?,?,?,?, 'PUBLISHED',?,?,?,?,?,?)`)
    .run(id, next, String(title).slice(0, 200), '', hash, fileName, uid || null,
         effectiveFrom ? String(effectiveFrom).slice(0, 10) : null, Date.now(), Date.now());
  audit(uid, 'agreement.uploaded', 'agreement', id,
    { version: next, fileName: String(fileName).slice(0, 120), hash, method: 'MANUAL' }, { reason: 'Signed agreement uploaded manually' });
  return get(id);
}

/* Pandit digital acceptance (Phase 24): consent checkbox + OTP verified against
   the pandit's registered mobile, then the version-locked acceptance row with
   IP + device. The unique index makes a repeat 409 — the API pre-checks only to
   return the friendlier message. */
function accept({ pid, uid, agreementId, consent, otp, ip, device }) {
  if (!consent) throw bad('Tick the consent box to accept the agreement');
  const a = get(agreementId);
  /* Unknown AND not-yet-published ids are indistinguishable to pandits. */
  if (!a || a.status !== 'PUBLISHED') throw notFound('Agreement not found');
  const pandit = db.prepare('SELECT * FROM pandits WHERE id=?').get(pid);
  if (!pandit) throw notFound('Pandit not found');
  if (!pandit.mobile) throw bad('Your account has no registered mobile number — add one before accepting');
  if (!otp) throw bad('Enter the OTP sent to your registered mobile');
  const already = db.prepare('SELECT id FROM agreement_acceptances WHERE agreement_id=? AND pandit_id=?').get(agreementId, pid);
  if (already) throw conflict('You have already accepted version ' + a.version);
  const { verifyOtp } = require('../routes/auth');
  verifyOtp(pandit.mobile, String(otp));
  const id = 'agc' + rid(6);
  tx(() => {
    db.prepare(`INSERT INTO agreement_acceptances(id,agreement_id,pandit_id,method,otp_verified,ip,device,accepted_at)
      VALUES(?,?,?,'DIGITAL',1,?,?,?)`).run(id, agreementId, pid, String(ip || '').slice(0, 60) || null, String(device || '').slice(0, 200) || null, Date.now());
    audit(uid, 'agreement.accepted', 'agreement_acceptance', id,
      { agreementId, version: a.version, method: 'DIGITAL', otpVerified: true, panditId: pid },
      { reason: 'Digital acceptance (OTP verified)', ip: String(ip || ''), device: String(device || ''),
        oldValue: { accepted: false }, newValue: { accepted: true, version: a.version, hash: a.document_hash } });
  })();
  notify(pandit.user_id, 'In-App', `You accepted agreement "${a.title}" (v${a.version}). A signed copy is in your portal.`);
  return db.prepare('SELECT * FROM agreement_acceptances WHERE id=?').get(id);
}

/* Pandit portal payload: the current published agreement + my acceptance
   history (every version I ever signed remains visible). */
function forPandit(pid) {
  const cur = current();
  const mine = db.prepare(`SELECT aa.*, a.version, a.title, a.document_hash FROM agreement_acceptances aa
    JOIN agreements a ON a.id = aa.agreement_id WHERE aa.pandit_id=? ORDER BY aa.accepted_at DESC`).all(pid);
  return {
    current: cur, myAcceptances: mine.map((r) => ({
      id: r.id, agreementId: r.agreement_id, version: r.version, title: r.title,
      method: r.method, otpVerified: !!r.otp_verified, ip: r.ip, device: r.device,
      acceptedAt: r.accepted_at, signatureRef: r.signature_ref
    }))
  };
}

const outAcceptance = (r) => ({
  id: r.id, agreementId: r.agreement_id, panditId: r.pandit_id, method: r.method,
  otpVerified: !!r.otp_verified, ip: r.ip, device: r.device, acceptedAt: r.accepted_at,
  signatureRef: r.signature_ref || null
});

/* Admin: all acceptances of one version (with pandit names for the screen). */
function acceptanceList(agreementId) {
  return db.prepare(`SELECT aa.*, p.name AS pandit_name FROM agreement_acceptances aa
    LEFT JOIN pandits p ON p.id = aa.pandit_id WHERE aa.agreement_id=? ORDER BY aa.accepted_at DESC`).all(agreementId)
    .map((r) => Object.assign(outAcceptance(r), { panditName: r.pandit_name || null }));
}

/* Admin screen data: every version with acceptance counts. */
function list() {
  return db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM agreement_acceptances aa WHERE aa.agreement_id=a.id) acceptance_count
    FROM agreements a ORDER BY a.version DESC, a.created_at DESC`).all().map(out);
}

module.exports = { STATUSES, METHODS, get, current, createDraft, publish, archive,
                   manualUpload, accept, forPandit, acceptanceList, list, out, outAcceptance };
