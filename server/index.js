require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const { db } = require('./db');
const { bootstrap } = require('./seed');
const { authenticate } = require('./auth');
const { buildState } = require('./lib/state');
const B = require('./services/bookings');
const S = require('./lib/serialize');
const upload = require('./lib/upload');
const { v, HttpError, j } = require('./lib/util');

bootstrap();
if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET) throw new Error('Set JWT_SECRET before running in production');
  if (!process.env.TWILIO_SID) console.warn('[warn] No SMS provider configured (TWILIO_*). Mobile OTP login cannot deliver codes.');
  if (process.env.PAYMENT_MODE !== 'razorpay') console.warn('[warn] PAYMENT_MODE is not razorpay: payments are simulated.');
}
const app = express();
app.disable('x-powered-by');

/* CORS for split hosting: the site can live on Netlify/GitHub Pages while the API runs
   on a host that runs Node (Render/Railway/Fly/VPS). Same-origin requests need no headers. */
const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
if (corsOrigins.length) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (corsOrigins.includes('*') || corsOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    }
    next();
  });
}
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

/* Razorpay webhook (server-to-server). Mounted BEFORE express.json so the raw body
   is available for HMAC verification. Idempotent: replayed events (same event id)
   are acknowledged without re-applying. Duplicate webhooks must never double-mark
   a payment. Server-side verification only — the frontend can never mark PAID. */
app.post('/api/webhooks/razorpay', express.raw({ type: 'application/json', limit: '256kb' }), (req, res) => {
  const wsecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!wsecret) return res.status(503).json({ error: 'Webhook not configured' });
  const sig = String(req.headers['x-razorpay-signature'] || '');
  const expected = crypto.createHmac('sha256', wsecret).update(req.body).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(400).json({ error: 'Bad signature' });
  let ev; try { ev = JSON.parse(req.body.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'Bad payload' }); }
  const eventId = ev.id || (ev.payload && ev.payload.payment && ev.payload.payment.entity && ev.payload.payment.entity.id) || '';
  if (eventId && db.prepare('SELECT 1 FROM idempotency_keys WHERE key=? AND scope=?').get('wh:' + eventId, 'razorpay.webhook')) return res.json({ ok: true, duplicate: true });
  try {
    const type = ev.event || '';
    const ent = (ev.payload && (ev.payload.payment || ev.payload.order) && (ev.payload.payment || ev.payload.order).entity) || {};
    const orderId = ent.order_id || '';
    if ((type === 'payment.captured' || type === 'order.paid') && orderId) {
      const bk = db.prepare('SELECT * FROM bookings WHERE id=(SELECT id FROM bookings WHERE json_extract(pay,\'$.orderId\')=? LIMIT 1)').get(orderId);
      if (bk) {
        const p = JSON.parse(bk.pay || '{}');
        if (!p.paid) {
          db.prepare('UPDATE bookings SET status=?, pay=?, log=? WHERE id=?')
            .run(bk.pandit_id ? 'Confirmed' : 'New', JSON.stringify({ ...p, paid: true, ref: ent.id || 'webhook' }), JSON.stringify(JSON.parse(bk.log || '[]').concat([['Payment received (webhook)', new Date().toISOString().slice(0, 10)]])), bk.id);
        }
      }
      const kd = db.prepare("SELECT * FROM kundalis WHERE order_id=? AND billing='PENDING_PAYMENT'").get(orderId);
      if (kd) db.prepare("UPDATE kundalis SET billing='PAID', payment_status='Paid', payment_id=? WHERE id=?").run(String(ent.id || 'webhook').slice(0, 60), kd.id);
    }
    if (eventId) db.prepare('INSERT OR IGNORE INTO idempotency_keys(key,scope,result,created_at) VALUES(?,?,?,?)').run('wh:' + eventId, 'razorpay.webhook', JSON.stringify({ type }), Date.now());
  } catch (e) { console.error('[webhook]', e.message); return res.status(500).json({ error: 'Handler error' }); }
  res.json({ ok: true });
});

app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'", 'https://checkout.razorpay.com'], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'blob:'], mediaSrc: ["'self'", 'blob:'], frameSrc: ["'self'", 'https://api.razorpay.com'],
    connectSrc: ["'self'", 'https://api.razorpay.com', 'https://lumberjack.razorpay.com'], objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"],
    upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
  } },
  strictTransportSecurity: process.env.NODE_ENV === 'production'
}));
app.use(express.json({ limit: '100kb' }));
app.use('/api', authenticate);
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false, skip: () => process.env.NODE_ENV === 'test' }));

/* Public POST /api/custom-puja: a guest-friendly Customized Puja request that lands
   in the admin "Puja requests" queue (full workflow from migration 008). Persists
   immediately — the admin panel reads the same row from the database. */
app.post('/api/custom-puja', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, skip: () => process.env.NODE_ENV === 'test' }), (req, res) => {
  const { v, bad, rid } = require('./lib/util');
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) throw bad('Name is required');
  if (!b.mobile || !/^\d{10}$/.test(String(b.mobile).replace(/\D/g, '').slice(-10))) throw bad('Enter a valid 10-digit mobile');
  const id = 'CR' + rid(5);
  db.prepare(`INSERT INTO custom_requests(id,user_id,name,mobile,language,requirement,purpose,deity,occasion,preferred_date,preferred_time,location,city,state,country,participants,budget,kundali_id,dosh_condition,remedy,sankalp,samagri_req,notes,attachments,status)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'NEW')`)
    .run(id, req.auth && req.auth.uid ? req.auth.uid : null,
      v.str(b.name, 'Name', { max: 80 }), String(b.mobile).replace(/\D/g, '').slice(-10),
      b.language ? v.str(b.language, 'Language', { max: 30, optional: true }) : '',
      b.requirement ? v.str(b.requirement, 'Requirement', { max: 1000, optional: true }) : '',
      b.purpose ? v.str(b.purpose, 'Purpose', { max: 200 }) : '',
      b.deity ? v.str(b.deity, 'Deity', { max: 60 }) : '',
      b.occasion ? v.str(b.occasion, 'Occasion', { max: 100, optional: true }) : '',
      b.preferredDate && /^\d{4}-\d{2}-\d{2}$/.test(String(b.preferredDate)) ? String(b.preferredDate) : '',
      b.preferredTime ? v.str(b.preferredTime, 'Preferred time', { max: 20, optional: true }) : '',
      b.location ? v.str(b.location, 'Location', { max: 200, optional: true }) : '',
      b.city ? v.str(b.city, 'City', { max: 80 }) : '',
      b.state ? v.str(b.state, 'State', { max: 80, optional: true }) : '',
      b.country ? v.str(b.country, 'Country', { max: 80, optional: true }) : '',
      b.participants ? v.int(b.participants, 'Participants', { min: 1, max: 5000 }) : null,
      b.budget ? v.int(b.budget, 'Budget', { min: 0, max: 10000000 }) : null,
      b.kundaliId && /^K[a-f0-9]{12}$/.test(String(b.kundaliId)) ? String(b.kundaliId) : '',
      b.doshCondition ? v.str(b.doshCondition, 'Dosh/condition', { max: 120, optional: true }) : '',
      b.remedy ? v.str(b.remedy, 'Remedy', { max: 300, optional: true }) : '',
      b.sankalp ? v.str(b.sankalp, 'Sankalp', { max: 300, optional: true }) : '',
      b.samagri ? v.str(b.samagri, 'Samagri', { max: 300, optional: true }) : '',
      b.notes ? v.str(b.notes, 'Notes', { max: 800 }) : '',
      JSON.stringify(Array.isArray(b.attachments) ? b.attachments.slice(0, 5).map((x) => String(x).slice(0, 200)) : []));
  res.status(201).json({ ok: true, id });
});

/* public API */
app.get('/api/health', (_q, r) => r.json({ ok: true }));
app.get('/api/state', (req, res) => res.json(buildState(req.auth)));
app.post('/api/quote', (req, res) => {
  const user = req.auth && req.auth.role === 'customer' ? db.prepare('SELECT * FROM users WHERE id=?').get(req.auth.uid) : null;
  const r = B.priceRequest(user, req.body, { strictCoupon: false });
  res.json({ q: r.q, couponError: r.couponError, coupon: r.coupon });
});
app.post('/api/leads', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, skip: () => process.env.NODE_ENV === 'test' }), (req, res) => {
  const type = v.oneOf(req.body.type, ['Contact', 'Corporate', 'Astrology', 'Kundli'], 'Type');
  db.prepare('INSERT INTO leads(type,name,details,date) VALUES(?,?,?,?)').run(type, v.str(req.body.name, 'Name', { max: 100 }), v.str(req.body.details, 'Details', { max: 800 }), new Date().toISOString().slice(0, 10));
  res.status(201).json({ ok: true });
});
app.use('/api/auth', require('./routes/auth').router);
app.use('/api/kundali', require('./routes/kundali'));
app.use('/api/pandit', require('./routes/pandit'));
app.use('/api/admin', require('./routes/admin'));
const customer = require('./routes/customer');
const customerPaths = ['/me', '/bookings', '/payments', '/orders', '/tickets'];
app.use('/api', (req, res, next) => (customerPaths.some((p) => req.path === p || req.path.startsWith(p + '/')) ? customer(req, res, next) : next()));
app.use('/api', (_q, _r, next) => next(new HttpError(404, 'Not found')));

/* puja photos and videos: random file names, served read-only. KYC files are never served here. */
app.use('/media', express.static(upload.dirs.media, { index: false, dotfiles: 'deny', setHeaders: (r) => r.setHeader('Content-Disposition', 'inline') }));
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

app.use((err, _req, res, _next) => {
  const status = err.status || (err.name === 'MulterError' ? 400 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : err.message });
});

const port = process.env.PORT || 3000;
if (require.main === module) app.listen(port, () => console.log(`DaivikPooja running at http://localhost:${port}  (payments: ${process.env.PAYMENT_MODE || 'mock'})`));
module.exports = app;
