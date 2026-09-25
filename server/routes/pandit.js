const router = require('express').Router();
const path = require('path');
const { db } = require('../db');
const { requireRole } = require('../auth');
const B = require('../services/bookings');
const S = require('../lib/serialize');
const upload = require('../lib/upload');
const { verifyOtp } = require('./auth');
const { v, bad, conflict, j, today, rid } = require('../lib/util');

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
router.post('/bookings/:id/complete', upload.media.array('media', 8), upload.verifyMagic(), (req, res) => {
  const urls = (req.files || []).map((f) => '/media/' + f.filename);
  res.json({ booking: S.booking(B.panditAct(pid(req), req.params.id, 'complete', urls)) });
});
router.post('/availability', (req, res) => {
  const date = v.date(req.body.date), row = db.prepare('SELECT off FROM pandits WHERE id=?').get(pid(req)), off = j(row.off, []);
  const i = off.indexOf(date);
  if (i > -1) off.splice(i, 1); else off.push(date);
  db.prepare('UPDATE pandits SET off=? WHERE id=?').run(JSON.stringify(off), pid(req));
  res.json({ ok: true });
});
router.patch('/profile', (req, res) => {
  const b = req.body, spec = list(b.spec).filter((s) => pujaIds().includes(s));
  if (!spec.length) throw bad('Select at least one puja');
  db.prepare('UPDATE pandits SET city=?, exp=?, langs=?, bio=?, spec=?, avail=? WHERE id=?')
    .run(CITIES.includes(b.city) ? b.city : 'Delhi NCR', v.int(b.exp, 'Experience', { min: 0, max: 70 }), JSON.stringify(list(b.langs).slice(0, 10)), v.str(b.bio, 'About', { optional: true, max: 600 }), JSON.stringify(spec), b.avail ? 1 : 0, pid(req));
  res.json({ ok: true });
});
router.post('/feature', (req, res) => {
  if ((process.env.PAYMENT_MODE || 'mock') !== 'mock') return res.status(501).json({ error: 'Featured-listing billing is not wired to the gateway yet. See README.' });
  db.prepare('UPDATE pandits SET featured=1 WHERE id=?').run(pid(req));
  res.json({ ok: true });
});

/* --- My puja photos: upload only for own assigned bookings; pending until the
   admin approves. Pandit sees their own uploads with approval status. --- */
const M = require('../services/pujaMedia');
router.post('/media', upload.media.array('media', 8), upload.verifyMagic(), (req, res) => {
  if (!req.files || !req.files.length) throw bad('Attach at least one photo');
  if (!String(req.body.altText || '').trim()) throw bad('Describe the photo (alt text is required)');
  res.status(201).json({ media: M.panditUpload({ pid: pid(req), uid: req.auth.uid, bookingId: req.body.bookingId, files: req.files, altText: req.body.altText }) });
  /* Variants for the new uploads (fire-and-forget; boot repair is the safety net). */
  require('../services/mediaVariants').repairAll(20).catch(() => {});
});
router.get('/media', (req, res) => res.json({ media: M.mineForPandit(pid(req)) }));
router.delete('/media/:id', (req, res) => res.json(M.remove({ uid: req.auth.uid, role: 'pandit', pid: pid(req), id: req.params.id })));
module.exports = router;
