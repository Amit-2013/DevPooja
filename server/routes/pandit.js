const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const { db } = require('../db');
const { requireRole } = require('../auth');
const B = require('../services/bookings');
const S = require('../lib/serialize');
const upload = require('../lib/upload');
const { verifyOtp } = require('./auth');
const { v, bad, conflict, j, today, rid } = require('../lib/util');
const P = require('../../shared/pricing');

const pujaIds = () => db.prepare('SELECT id FROM pujas').all().map((r) => r.id);
const list = (x) => (Array.isArray(x) ? x : String(x || '').split(',')).map((s) => String(s).trim()).filter(Boolean);
const CITIES = ['Delhi NCR', 'Mumbai', 'Bengaluru', 'Pune', 'Jaipur', 'Lucknow', 'Varanasi', 'Ahmedabad', 'Chennai', 'Hyderabad'];

/* Public: registration with KYC documents (multipart). The mobile number must be verified by OTP. */
router.post('/register', upload.kyc.fields([{ name: 'idDoc', maxCount: 1 }, { name: 'cert', maxCount: 1 }, { name: 'photo', maxCount: 1 }]), upload.verifyMagic(), (req, res) => {
  const b = req.body, mobile = v.mobile(b.mobile);
  verifyOtp(mobile, b.otp);
  const name = v.str(b.name, 'Name', { max: 80 });
  const spec = list(b.spec).filter((s) => pujaIds().includes(s)), langs = list(b.langs).slice(0, 10);
  if (!spec.length) throw bad('Select at least one puja');
  if (!langs.length) throw bad('Select at least one language');
  if (!req.files || !req.files.idDoc) throw bad('Attach an ID document');
  if (db.prepare('SELECT 1 FROM users WHERE mobile=?').get(mobile)) throw conflict('This mobile number is already registered');
  const uid = 'pu' + rid(3), pid = 'p' + rid(3);
  const files = {}; Object.entries(req.files).forEach(([k, f]) => { files[k] = f[0].filename; });
  db.prepare("INSERT INTO users(id,role,name,mobile,joined,created_at) VALUES(?,'pandit',?,?,?,?)").run(uid, name, mobile, today(), Date.now());
  db.prepare("INSERT INTO pandits(id,user_id,name,city,exp,langs,spec,pf,bio,color,status,mobile,kyc) VALUES(?,?,?,?,?,?,?,0.9,'New pandit applicant.','#555555','pending',?,?)")
    .run(pid, uid, name, CITIES.includes(b.city) ? b.city : 'Delhi NCR', v.int(b.exp || 0, 'Experience', { min: 0, max: 70 }), JSON.stringify(langs), JSON.stringify(spec), mobile, JSON.stringify({ idType: String(b.idType || '').slice(0, 30), files }));
  res.status(201).json({ ok: true });
});

router.use(requireRole('pandit'));
const pid = (req) => req.auth.pid;

router.post('/bookings/:id/:action(accept|reject|start)', (req, res) => {
  const p = db.prepare('SELECT status FROM pandits WHERE id=?').get(pid(req));
  if (p.status !== 'verified') throw bad('Your KYC is not verified yet');
  res.json({ booking: S.booking(B.panditAct(pid(req), req.params.id, req.params.action)) });
});
/* Phase 16: a pandit can cancel an assigned booking — customer refunded at the
   standard tier; compensation only outside the notice window (services/cancellation). */
router.post('/bookings/:id/cancel', (req, res) => {
  const CX = require('../services/cancellation');
  res.json({ booking: S.booking(CX.panditCancel(pid(req), req.params.id, req.body && req.body.reason)) });
});
router.post('/bookings/:id/complete', upload.media.array('media', 8), upload.verifyMagic(), (req, res) => {
  const urls = (req.files || []).map((f) => '/media/' + f.filename);
  res.json({ booking: S.booking(B.panditAct(pid(req), req.params.id, 'complete', urls)) });
});
router.post('/availability', (req, res) => {
  const date = v.date(req.body.date), row = db.prepare('SELECT off, blocked_dates FROM pandits WHERE id=?').get(pid(req)), off = j(row.off, []);
  /* If the date is in the structured blocked list, removing it there takes priority
     so the legacy toggle can un-block what it previously blocked. */
  const blocked = j(row.blocked_dates, []);
  const bi = blocked.findIndex((b) => b && b.date === date);
  if (bi > -1) { blocked.splice(bi, 1); db.prepare('UPDATE pandits SET blocked_dates=? WHERE id=?').run(JSON.stringify(blocked), pid(req)); }
  const i = off.indexOf(date);
  if (i > -1) off.splice(i, 1); else off.push(date);
  db.prepare('UPDATE pandits SET off=? WHERE id=?').run(JSON.stringify(off), pid(req));
  res.json({ ok: true });
});

/* --- Centralized availability calendar (Phase 3): rules + per-date overrides --- */
router.get('/calendar', (req, res) => {
  const row = db.prepare('SELECT * FROM pandits WHERE id=?').get(pid(req));
  res.json({ calendar: require('../services/availability').configOf(row) });
});

/* --- My KYC documents (Phase 4): per-document upload + status --- */
const K = require('../services/kyc');
router.get('/kyc/documents', (req, res) => {
  res.json({ documents: K.forPandit(pid(req)).map(K.out) });
});
router.post('/kyc/documents', upload.kyc.single('doc'), upload.verifyMagic(), (req, res) => {
  if (!req.file) throw bad('Attach the document file');
  const row = K.upload({ pid: pid(req), uid: req.auth.uid, docType: req.body.docType,
    fileName: req.file.filename, originalName: req.file.originalname });
  res.status(201).json({ document: K.out(row) });
});
/* --- My agreement (Phases 23-25): read the published version, accept with consent + OTP --- */
const AG = require('../services/agreements');
router.get('/agreement', (req, res) => {
  res.json(AG.forPandit(pid(req)));
});
/* The acceptance OTP is issued SERVER-SIDE against the pandit's registered
   mobile (pandits.mobile) — the portal never needs to know the number. Reuses
   the same otps table + hashing as auth.js (demo code 123456), so the accept
   route's verifyOtp works unchanged and no parallel OTP path is created. */
router.post('/agreement/send-otp', async (req, res) => {
  const crypto = require('crypto');
  const { sendOtp } = require('../services/notify');
  const p = db.prepare('SELECT * FROM pandits WHERE id=?').get(pid(req));
  if (!p || !p.mobile) throw bad('Your account has no registered mobile number — add one before accepting');
  const demoOn = () => String(process.env.DEMO_MODE || (process.env.NODE_ENV === 'production' ? 'false' : 'true')) === 'true';
  const code = demoOn() ? '123456' : String(crypto.randomInt(100000, 1000000));
  const hash = (m, c) => crypto.createHash('sha256').update(m + ':' + c + ':' + (process.env.JWT_SECRET || 'dev')).digest('hex');
  db.prepare('INSERT INTO otps(mobile,code_hash,expires,attempts) VALUES(?,?,?,0) ON CONFLICT(mobile) DO UPDATE SET code_hash=excluded.code_hash, expires=excluded.expires, attempts=0')
    .run(p.mobile, hash(p.mobile, code), Date.now() + 5 * 60 * 1000);
  await sendOtp(p.mobile, code);
  res.json({ ok: true, ...(process.env.NODE_ENV !== 'production' && demoOn() ? { devOtp: code } : {}) });
});
router.post('/agreement/accept', (req, res) => {
  const b = req.body || {};
  const row = AG.accept({ pid: pid(req), uid: req.auth.uid, agreementId: b.agreementId,
    consent: b.consent, otp: b.otp,
    ip: req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : (req.socket && req.socket.remoteAddress) || '',
    device: req.headers['user-agent'] || '' });
  res.json({ acceptance: AG.outAcceptance(row) });
});
router.put('/calendar', (req, res) => {
  const b = req.body || {};
  const AV = require('../services/availability');
  const cur = db.prepare('SELECT * FROM pandits WHERE id=?').get(pid(req));
  const weekly = (Array.isArray(b.weeklyOff) ? b.weeklyOff : []).map((n) => v.int(n, 'Weekday', { min: 0, max: 6 }));
  const slots = (Array.isArray(b.slots) ? b.slots : []).filter((s) => P.SLOTS.includes(s));
  const radius = b.radiusKm === null || b.radiusKm === undefined || b.radiusKm === '' ? null : v.int(b.radiusKm, 'Radius', { min: 1, max: 500 });
  const base = (() => {
    if (b.baseLat != null && b.baseLon != null) return { lat: Number(b.baseLat), lon: Number(b.baseLon) };
    if (b.baseCity) { const pl = AV.resolvePlace(b.baseCity); if (pl) return { lat: pl.lat, lon: pl.lon }; }
    return null;
  })();
  if (radius != null && !base && cur.base_lat == null && !AV.resolvePlace(cur.city)) throw bad('Set a base location (or a recognizable city) before enabling the service radius');
  db.prepare(`UPDATE pandits SET weekly_off=?, slots=?, radius_km=?, base_lat=?, base_lon=?,
    online_enabled=?, temple_enabled=? WHERE id=?`)
    .run(JSON.stringify([...new Set(weekly)].sort()), JSON.stringify(slots), radius,
         base ? base.lat : cur.base_lat, base ? base.lon : cur.base_lon,
         b.onlineEnabled === undefined ? cur.online_enabled : (b.onlineEnabled ? 1 : 0),
         b.templeEnabled === undefined ? cur.temple_enabled : (b.templeEnabled ? 1 : 0), pid(req));
  res.json({ calendar: AV.configOf(db.prepare('SELECT * FROM pandits WHERE id=?').get(pid(req))) });
});
router.post('/calendar/dates', (req, res) => {
  const b = req.body || {}, date = v.date(b.date);
  const AV = require('../services/availability');
  const row = db.prepare('SELECT off, holidays, blocked_dates FROM pandits WHERE id=?').get(pid(req));
  const holidays = j(row.holidays, []), blocked = j(row.blocked_dates, []);
  const kind = v.oneOf(b.kind || 'holiday', ['holiday', 'blocked'], 'Kind');
  if (kind === 'holiday') {
    const i = holidays.indexOf(date);
    if (i > -1) holidays.splice(i, 1); else holidays.push(date);
  } else {
    const i = blocked.findIndex((x) => x && x.date === date);
    if (i > -1) blocked.splice(i, 1);
    else blocked.push({ date, reason: String(b.reason || '').slice(0, 120) });
  }
  db.prepare('UPDATE pandits SET holidays=?, blocked_dates=? WHERE id=?').run(JSON.stringify(holidays), JSON.stringify(blocked), pid(req));
  res.json({ calendar: AV.configOf(db.prepare('SELECT * FROM pandits WHERE id=?').get(pid(req))) });
});
/* Why can't this pandit take a given booking? Used by the portal calendar UX. */
router.get('/calendar/why', (req, res) => {
  const date = v.date(req.query.date), slot = req.query.slot && P.SLOTS.includes(req.query.slot) ? req.query.slot : null;
  const row = db.prepare('SELECT * FROM pandits WHERE id=?').get(pid(req));
  res.json({ verdict: require('../services/availability').check(row, date, slot, { mode: req.query.mode }) });
});
router.patch('/profile', (req, res) => {
  const b = req.body, spec = list(b.spec).filter((s) => pujaIds().includes(s));
  if (!spec.length) throw bad('Select at least one puja');
  db.prepare('UPDATE pandits SET city=?, exp=?, langs=?, bio=?, spec=?, avail=?, gotra=?, qualifications=?, veda_school=? WHERE id=?')
    .run(CITIES.includes(b.city) ? b.city : 'Delhi NCR', v.int(b.exp, 'Experience', { min: 0, max: 70 }), JSON.stringify(list(b.langs).slice(0, 10)), v.str(b.bio, 'About', { optional: true, max: 600 }), JSON.stringify(spec), b.avail ? 1 : 0,
      v.str(b.gotra, 'Gotra', { optional: true, max: 60 }), v.str(b.quals, 'Qualifications', { optional: true, max: 600 }), v.str(b.veda, 'Tradition', { optional: true, max: 60 }), pid(req));
  res.json({ ok: true });
});

/* Profile photo (Phase 5): image-only, magic-checked, stored under media/ so it
   is served publicly from /media like catalogue photos. KYC files stay private. */
router.post('/profile/photo', upload.kyc.single('photo'), upload.verifyMagic(), (req, res) => {
  if (!req.file) throw bad('Attach a photo');
  if (req.file.mimetype === 'application/pdf') { try { fs.unlinkSync(req.file.path); } catch (e) {} throw bad('Profile photos must be images'); }
  const p = db.prepare('SELECT photo_file FROM pandits WHERE id=?').get(pid(req));
  const name = 'prof-' + rid(10) + path.extname(req.file.originalname || '.jpg').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
  const dest = path.join(upload.dirs.media, name);
  fs.renameSync(req.file.path, dest);
  db.prepare('UPDATE pandits SET photo_file=? WHERE id=?').run(name, pid(req));
  if (p && p.photo_file) { try { fs.unlinkSync(path.join(upload.dirs.media, p.photo_file)); } catch (e) { /* already gone */ } }
  res.json({ ok: true, photo: '/media/' + name });
});

/* My QA history + derived service metrics (Phases 5 + 17). */
router.get('/me/qa', (req, res) => {
  const Q = require('../services/qa');
  res.json({ records: Q.forPandit(pid(req)).map(Q.out), derived: Q.derived(pid(req)) });
});

/* My money ledger (Phase 10): DAKSHINA share rows and the negative PAYOUT rows
   that settle them — the pandit-side view of the transactions ledger. */
router.get('/me/ledger', (req, res) => {
  const L = require('../services/ledger');
  res.json({ entries: L.list({ panditId: pid(req), limit: 50 }) });
});
/* My activation trial (Phase 18): status the pandit can act on. */
router.get('/me/trial', (req, res) => {
  const T = require('../services/trial');
  res.json({ trials: T.forPandit(pid(req)) });
});
/* --- Incident reporting (Phase 20): the pandit's on-ground channel --- */
const INC = require('../services/incidents');
router.get('/me/incidents', (req, res) => {
  res.json({ incidents: INC.forPandit(pid(req)), categories: INC.CATEGORIES });
});
router.post('/incidents', upload.media.array('evidence', 8), upload.verifyMagic(), (req, res) => {
  const body = req.body || {};
  /* FE contract: files upload straight through here; JSON evidence urls (from the
     evidence-only endpoint) ride along — the service filters to /media/ anyway. */
  const urls = [...(req.files || []).map((f) => '/media/' + f.filename), ...(Array.isArray(body.evidence) ? body.evidence : [])];
  const inc = INC.report(pid(req), { bookingId: body.bookingId, category: body.category, description: body.description, evidence: urls });
  res.status(201).json({ incident: inc });
});
/* Evidence-only upload (report first, attach while typing) — same pipeline. */
router.post('/incident-evidence', upload.media.array('evidence', 8), upload.verifyMagic(), (req, res) => {
  res.json({ urls: (req.files || []).map((f) => '/media/' + f.filename) });
});
router.post('/feature', (req, res) => {
  if ((process.env.PAYMENT_MODE || 'mock') !== 'mock') return res.status(501).json({ error: 'Featured-listing billing is not wired to the gateway yet. See README.' });
  db.prepare('UPDATE pandits SET featured=1 WHERE id=?').run(pid(req));
  res.json({ ok: true });
});

/* --- My puja photos: upload only for own assigned bookings; pending until the
   admin approves. Pandit sees their own uploads with approval status. --- */
const M = require('../services/pujaMedia');
const { wrap } = require('../lib/util');
router.post('/media', upload.media.array('media', 8), upload.verifyMagic(), wrap(async (req, res) => {
  if (!req.files || !req.files.length) throw bad('Attach at least one photo');
  if (!String(req.body.altText || '').trim()) throw bad('Describe the photo (alt text is required)');
  const media = M.panditUpload({ pid: pid(req), uid: req.auth.uid, bookingId: req.body.bookingId, files: req.files, altText: req.body.altText });
  /* Variants are generated inline (awaited) so the client never sees rows whose
     derived artifacts may still be in flight — a former background-repair race. */
  for (const m of media) await require('../services/mediaVariants').ensureVariants(M.row(m.id));
  res.status(201).json({ media });
}));
router.get('/media', (req, res) => res.json({ media: M.mineForPandit(pid(req)) }));
router.delete('/media/:id', (req, res) => res.json(M.remove({ uid: req.auth.uid, role: 'pandit', pid: pid(req), id: req.params.id })));
module.exports = router;
