const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const { sign } = require('../auth');
const { sendOtp } = require('../services/notify');
const auditMod = require('../lib/audit');
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

/* --- password lifecycle ---------------------------------------------------- */
/* Constant-time string compare helper. */
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/* Returns a one-time, hashed, 30-minute reset token (the raw token is shown once,
   never stored). Used by the admin "Reset password" flow. */
function issuePasswordReset(userId, createdBy) {
  const raw = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO password_resets(user_id,token_hash,expires,used,created_by,created_at) VALUES(?,?,?,?,?,?)')
    .run(userId, crypto.createHash('sha256').update(raw).digest('hex'), Date.now() + 30 * 60 * 1000, 0, createdBy || null, Date.now());
  return raw;
}

/* Marks a successful login: clears failure counters, stamps last-login, logs activity. */
function loginOk(u, method, req) {
  db.prepare("UPDATE users SET last_login_at=?, last_login_method=?, failed_logins=0, locked_until=NULL WHERE id=?").run(Date.now(), method, u.id);
  auditMod.logLogin(u.id, method, 1, '', req.ip || '');
  return { mustChangePassword: !!u.force_change };
}

/* Lockout gate for password logins: 5 consecutive failures lock the account for 15 min. */
function checkLock(u) {
  if (u.locked_until && u.locked_until > Date.now()) {
    const mins = Math.ceil((u.locked_until - Date.now()) / 60000);
    throw new HttpError(429, 'Account temporarily locked after failed attempts. Try again in ' + mins + ' minute(s).');
  }
}
function registerFailure(userId) {
  const u = db.prepare('SELECT failed_logins FROM users WHERE id=?').get(userId);
  if (!u) return;
  const fails = (u.failed_logins || 0) + 1;
  const lock = fails >= 5 ? Date.now() + 15 * 60 * 1000 : null;
  db.prepare('UPDATE users SET failed_logins=?, locked_until=? WHERE id=?').run(fails, lock, userId);
  if (lock) auditMod.logLogin(userId, 'email', 0, 'locked after 5 failures', '');
}

/* Change password (self-service, all roles): verifies the current password first. */
router.post('/change-password', limiter(10), (req, res) => {
  if (!req.auth) throw new HttpError(401, 'Please log in');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.auth.uid);
  if (!u || !u.pass_hash) throw bad('This account has no password set. Log in with your mobile OTP.');
  if (!bcrypt.compareSync(String(req.body.currentPassword || ''), u.pass_hash)) { registerFailure(u.id); throw new HttpError(401, 'Current password is incorrect'); }
  const pw = String(req.body.newPassword || '');
  if (pw.length < 8) throw bad('New password needs at least 8 characters');
  if (safeEq(pw, req.body.currentPassword || '')) throw bad('Choose a password you have not used here before');
  db.prepare('UPDATE users SET pass_hash=?, force_change=0 WHERE id=?').run(bcrypt.hashSync(pw, 10), u.id);
  auditMod.audit(u.id, 'password.change', 'user', u.id, {});
  res.json({ ok: true, mustChangePassword: false });
});

/* Admin token issuance honours the force-change flag without weakening the login. */
function adminLoginResponse(u, req) {
  const meta = loginOk(u, 'admin', req);
  return { token: sign(u), role: 'admin', mustChangePassword: meta.mustChangePassword };
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
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.user_id);
    if (!u) throw new HttpError(404, 'No pandit account for this number. Register first.');
    if (u.status && u.status !== 'active') throw new HttpError(403, u.status === 'suspended' ? 'Your account is suspended. Please contact support.' : 'This account has been disabled. Please contact support.');
    const meta = loginOk(u, 'mobile-otp', req);
    return res.json({ token: sign({ id: p.user_id, role: 'pandit' }, p.id), role: 'pandit', mustChangePassword: meta.mustChangePassword });
  }
  let u = db.prepare("SELECT * FROM users WHERE mobile=? AND role='customer'").get(mobile);
  if (!u) {
    if (db.prepare('SELECT 1 FROM users WHERE mobile=?').get(mobile)) throw bad('This number belongs to a partner account');
    const id = 'u' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    db.prepare("INSERT INTO users(id,role,name,mobile,pts,pref,joined,created_at) VALUES(?,'customer',?,?,50,?,?,?)").run(id, v.str(req.body.name, 'Name', { optional: true, max: 80 }) || 'Devotee', mobile, JSON.stringify({ deity: '', lang: 'English', wa: true, sms: true, em: true }), today(), Date.now());
    u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  }
  if (u.status && u.status !== 'active') throw new HttpError(403, u.status === 'suspended' ? 'Your account is suspended. Please contact support.' : 'This account has been disabled. Please contact support.');
  const meta = loginOk(u, 'mobile-otp', req);
  res.json({ token: sign(u), role: 'customer', mustChangePassword: meta.mustChangePassword });
});

/* Email + password: signs in an existing account, or creates one (name required) */
router.post('/email', limiter(20), (req, res) => {
  const email = v.email(req.body.email), pw = String(req.body.password || '');
  if (pw.length < 8) throw bad('Password needs at least 8 characters');
  let u = db.prepare("SELECT * FROM users WHERE email=? AND role='customer'").get(email);
  if (u) {
    if (u.status && u.status !== 'active') throw new HttpError(403, u.status === 'suspended' ? 'Your account is suspended. Please contact support.' : 'This account has been disabled. Please contact support.');
    if (!u.pass_hash) throw bad('This account uses mobile OTP. Please log in with your mobile number.');
    checkLock(u);
    if (!bcrypt.compareSync(pw, u.pass_hash)) { auditMod.logLogin(u.id, 'email', 0, 'wrong password', req.ip || ''); registerFailure(u.id); throw new HttpError(401, 'Incorrect email or password'); }
  } else {
    const id = 'u' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    db.prepare("INSERT INTO users(id,role,name,email,pass_hash,pts,pref,joined,created_at) VALUES(?,'customer',?,?,?,50,?,?,?)").run(id, v.str(req.body.name, 'Name', { optional: true, max: 80 }) || 'Devotee', email, bcrypt.hashSync(pw, 10), JSON.stringify({ deity: '', lang: 'English', wa: true, sms: true, em: true }), today(), Date.now());
    u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  }
  const meta = loginOk(u, 'email', req);
  res.json({ token: sign(u), role: 'customer', mustChangePassword: meta.mustChangePassword });
});

router.post('/admin', limiter(10), (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE role='admin' AND email=?").get(String(req.body.email || '').toLowerCase());
  if (u && u.status && u.status !== 'active') { auditMod.logLogin(u.id, 'admin', 0, u.status, req.ip || ''); throw new HttpError(403, 'This admin account is ' + u.status + '.'); }
  if (u) checkLock(u);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.pass_hash || '')) {
    if (u) { auditMod.logLogin(u.id, 'admin', 0, 'wrong password', req.ip || ''); registerFailure(u.id); }
    throw new HttpError(401, 'Incorrect credentials');
  }
  res.json(adminLoginResponse(u, req));
});

/* Demo shortcuts, only when DEMO_MODE=true. Demo accounts are clearly marked in the
   admin (mobile prefix 9811100%/98100000%); they never exist in production because
   seedDemo() only runs when demo mode is on. Account status is honoured here too:
   a suspended/disabled demo account cannot log in even in demo mode. */
router.post('/demo', (req, res) => {
  if (!demoOn()) throw new HttpError(404, 'Not found');
  const refuse = (u) => { if (u.status && u.status !== 'active') throw new HttpError(403, u.status === 'suspended' ? 'Your account is suspended. Please contact support.' : 'This account has been disabled. Please contact support.'); };
  if (req.body.role === 'pandit') { const p = db.prepare("SELECT * FROM pandits WHERE id='p1'").get(); if (!p) throw new HttpError(404, 'No demo data'); const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.user_id); refuse(u); const meta = loginOk(u, 'demo', req); return res.json({ token: sign({ id: p.user_id, role: 'pandit' }, p.id), role: 'pandit', mustChangePassword: meta.mustChangePassword }); }
  const u = db.prepare("SELECT * FROM users WHERE id='u1'").get();
  if (!u) throw new HttpError(404, 'No demo data');
  refuse(u);
  const meta = loginOk(u, 'demo', req);
  res.json({ token: sign(u), role: 'customer', mustChangePassword: meta.mustChangePassword });
});

module.exports = { router, verifyOtp, issuePasswordReset, loginOk, registerFailure, checkLock, adminLoginResponse };
