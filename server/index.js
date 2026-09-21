require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
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
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
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
if (require.main === module) app.listen(port, () => console.log(`DevPooja running at http://localhost:${port}  (payments: ${process.env.PAYMENT_MODE || 'mock'})`));
module.exports = app;
