const crypto = require('crypto');
const iso = (d) => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
const addDays = (n) => { const x = new Date(); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() + n); return iso(x); };
const today = () => iso(new Date());
const j = (v, d) => { try { return v == null ? d : JSON.parse(v); } catch { return d; } };
const rid = (n = 8) => crypto.randomBytes(n).toString('hex');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
/* Express 4 does not catch rejected promises: wrap async handlers */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (m) => new HttpError(400, m);
const forbidden = (m = 'Not allowed') => new HttpError(403, m);
const notFound = (m = 'Not found') => new HttpError(404, m);
const conflict = (m) => new HttpError(409, m);

/* tiny validators */
const v = {
  str(x, name, { min = 1, max = 500, optional = false } = {}) {
    if (x == null || x === '') { if (optional) return ''; throw bad(name + ' is required'); }
    const s = String(x).trim();
    if (s.length < min) throw bad(name + ' is too short');
    if (s.length > max) throw bad(name + ' is too long');
    return s;
  },
  int(x, name, { min = -Infinity, max = Infinity } = {}) {
    const n = Number(x);
    if (!Number.isInteger(n) || n < min || n > max) throw bad(name + ' is invalid');
    return n;
  },
  mobile(x) { const s = String(x || '').trim(); if (!/^[6-9]\d{9}$/.test(s)) throw bad('Enter a valid 10-digit Indian mobile number'); return s; },
  email(x) { const s = String(x || '').trim().toLowerCase(); if (!/^\S+@\S+\.\S+$/.test(s) || s.length > 120) throw bad('Enter a valid email'); return s; },
  date(x, name = 'Date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x)) || isNaN(new Date(x + 'T12:00:00'))) throw bad(name + ' is invalid'); return String(x); },
  oneOf(x, list, name) { if (!list.includes(x)) throw bad(name + ' is invalid'); return x; },
  arr(x, name, max = 20) { if (x == null) return []; if (!Array.isArray(x) || x.length > max) throw bad(name + ' is invalid'); return x; }
};
module.exports = { wrap, iso, addDays, today, j, rid, HttpError, bad, forbidden, notFound, conflict, v };
