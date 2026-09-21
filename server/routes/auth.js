const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const { sign } = require('../auth');
const { sendOtp } = require('../services/notify');
const { v, bad, HttpError, today, wrap } = require('../lib/util');

const limiter = (max) => rateLimit({ windowMs: 15 * 60 * 1000, limit: max, standardHeaders: true, legacyHeaders: false, skip: () => process.env.NODE_ENV === 'test', message: { error: 'Too many attempts. Try again in a few minutes.' } });
const hash = (m, code) => crypto.createHash('sha256').update(m + ':' + code + ':' + (process.env.JWT_SECRET || 'dev')).digest('hex');
const demoOn = () => String(process.env.DEMO_MODE || (process.env.NODE_ENV === 'production' ? 'false' : 'true')) === 'true';

function verifyOtp(mobile, code) {
  const r = db.prepare('SELECT * FROM otps WHERE mobile=?').get(mobile);
  if (!r || r.expires < Date.now()) throw bad('OTP expired. Request a new one.');
  if (r.attempts >= 5) throw new HttpError(429, 'Too many wrong attempts. Request a new OTP.');
  const a = Buffer.from(hash(mobile, String(code || '')));
  const b = Buffer.from(r.code_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { db.prepare('UPDATE otps SET attempts=attempts+1 WHERE mobile=?').run(mobile); throw bad('Incorrect OTP'); }
  db.prepare('DELETE FROM otps WHERE mobile=?').run(mobile);
}

router.post('/otp/send', limiter(15), wrap(async (req, res) => {
  const mobile = v.mobile(req.body.mobile);
  const code = demoOn() ? '123456' : String(crypto.randomInt(100000, 1000000));
  db.prepare('INSERT INTO otps(mobile,code_hash,expires,attempts) VALUES(?,?,?,0) ON CONFLICT(mobile) DO UPDATE SET code_hash=excluded.code_hash, expires=excluded.expires, attempts=0').run(mobile, hash(mobile, code), Date.now() + 5 * 60 * 1000);
  await sendOtp(mobile, code);
  res.json({ ok: true, ...(process.env.NODE_ENV !== 'production' && demoOn() ? { devOtp: code } : {}) });
}));

router.post('/otp/verify', limiter(30), (req, res) => {
  const mobile = v.mobile(req.body.mobile);
  verifyOtp(mobile, req.body.otp);
  if (req.body.as === 'pandit') {
    const p = db.prepare('SELECT * FROM pandits WHERE mobile=?').get(mobile);
    if (!p) throw new HttpError(404, 'No pandit account for this number. Register first.');
    return res.json({ token: sign({ id: p.user_id, role: 'pandit' }, p.id), role: 'pandit' });
  }
  let u = db.prepare("SELECT * FROM users WHERE mobile=? AND role='customer'").get(mobile);
  if (!u) {
    if (db.prepare('SELECT 1 FROM users WHERE mobile=?').get(mobile)) throw bad('This number belongs to a partner account');
    const id = 'u' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    db.prepare("INSERT INTO users(id,role,name,mobile,pts,pref,joined,created_at) VALUES(?,'customer',?,?,50,?,?,?)").run(id, v.str(req.body.name, 'Name', { optional: true, max: 80 }) || 'Devotee', mobile, JSON.stringify({ deity: '', lang: 'English', wa: true, sms: true, em: true }), today(), Date.now());
    u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  }
  res.json({ token: sign(u), role: 'customer' });
});

/* Email + password: signs in an existing account, or creates one (name required) */
router.post('/email', limiter(20), (req, res) => {
  const email = v.email(req.body.email), pw = String(req.body.password || '');
  if (pw.length < 8) throw bad('Password needs at least 8 characters');
  let u = db.prepare("SELECT * FROM users WHERE email=? AND role='customer'").get(email);
  if (u) {
    if (!u.pass_hash) throw bad('This account uses mobile OTP. Please log in with your mobile number.');
    if (!bcrypt.compareSync(pw, u.pass_hash)) throw new HttpError(401, 'Incorrect email or password');
  } else {
    const id = 'u' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    db.prepare("INSERT INTO users(id,role,name,email,pass_hash,pts,pref,joined,created_at) VALUES(?,'customer',?,?,?,50,?,?,?)").run(id, v.str(req.body.name, 'Name', { optional: true, max: 80 }) || 'Devotee', email, bcrypt.hashSync(pw, 10), JSON.stringify({ deity: '', lang: 'English', wa: true, sms: true, em: true }), today(), Date.now());
    u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  }
  res.json({ token: sign(u), role: 'customer' });
});

router.post('/admin', limiter(10), (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE role='admin' AND email=?").get(String(req.body.email || '').toLowerCase());
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.pass_hash || '')) throw new HttpError(401, 'Incorrect credentials');
  res.json({ token: sign(u), role: 'admin' });
});

/* Demo shortcuts, only when DEMO_MODE=true */
router.post('/demo', (req, res) => {
  if (!demoOn()) throw new HttpError(404, 'Not found');
  if (req.body.role === 'pandit') { const p = db.prepare("SELECT * FROM pandits WHERE id='p1'").get(); if (!p) throw new HttpError(404, 'No demo data'); return res.json({ token: sign({ id: p.user_id, role: 'pandit' }, p.id), role: 'pandit' }); }
  const u = db.prepare("SELECT * FROM users WHERE id='u1'").get();
  if (!u) throw new HttpError(404, 'No demo data');
  res.json({ token: sign(u), role: 'customer' });
});

module.exports = { router, verifyOtp };
