const router = require('express').Router();
const path = require('path');
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
