const jwt = require('jsonwebtoken');
const { db } = require('./db');
const { HttpError } = require('./lib/util');

const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s && process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET must be set in production');
  return s || 'dev-only-secret-change-me';
};
const sign = (user, pid) => jwt.sign({ uid: user.id, role: user.role, pid: pid || null }, secret(), { expiresIn: '7d' });

/* Reads Authorization: Bearer <token>. Always re-checks the user in the DB, so role changes and deletions take effect immediately. */
function authenticate(req, _res, next) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    try {
      const p = jwt.verify(h.slice(7), secret());
      const u = db.prepare('SELECT id, role FROM users WHERE id=?').get(p.uid);
      if (u) {
        let pid = null;
        if (u.role === 'pandit') { const pr = db.prepare('SELECT id FROM pandits WHERE user_id=?').get(u.id); pid = pr && pr.id; }
        req.auth = { uid: u.id, role: u.role, pid };
      }
    } catch { /* invalid or expired token: treated as anonymous */ }
  }
  next();
}
const requireRole = (...roles) => (req, _res, next) => {
  if (!req.auth) return next(new HttpError(401, 'Please log in'));
  if (!roles.includes(req.auth.role)) return next(new HttpError(403, 'Not allowed'));
  next();
};
const currentUser = (req) => db.prepare('SELECT * FROM users WHERE id=?').get(req.auth.uid);
module.exports = { sign, authenticate, requireRole, currentUser };
