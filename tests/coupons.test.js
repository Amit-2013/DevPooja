/* Phase 14: coupons — scoping (ALL|PUJA|KUNDALI), validity window, per-puja
   restriction, per-user redemption cap counted at the money moment, cart
   (shop orders) redemption, admin GET/create surface, audits, access. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-cpn-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const test = require('node:test');
const assert = require('node:assert/strict');
const seedMod = require('../server/seed');
const app = require('../server/index.js');

let server, base;
test.before(async () => {
  await seedMod.settledMedia();
  await new Promise((r) => { server = app.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; r(); }); });
});
test.after(() => { server.closeAllConnections(); server.close(); });

async function call(method, url, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(base + '/api' + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const login = async (role) => (await call('POST', '/auth/demo', { body: { role } })).json.token;
const admin = async () => (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
const { db } = require('../server/db');
const dayPlus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const in5days = () => new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
const in5daysMs = () => Date.now() + 5 * 864e5;
const ago2daysMs = () => Date.now() - 2 * 864e5;

const bookingBody = (o = {}) => ({ pujaId: 'satyanarayan', mode: 'home', date: dayPlus(30), slot: '10:00 AM', addr: { line: '12 Test Street', city: 'Delhi NCR', pin: '110001' }, panditId: 'p1', sam: [], pra: [], ...o });
const anyKit = () => db.prepare('SELECT id FROM kits LIMIT 1').get().id;

test('admin coupon surface: GET list, scoped create with window and per-user, audits, access', async () => {
  const at = await admin();
  const listed = await call('GET', '/admin/coupons', { token: at });
  assert.equal(listed.status, 200);
  assert.ok(listed.json.coupons.length >= 3, 'seeded coupons listed');
  assert.ok(listed.json.coupons.every((c) => c.scope === 'ALL' && c.per_user === 0), 'backfilled scope/per_user');

  const created = await call('POST', '/admin/coupons', { token: at, body: { code: 'PujaOnly', type: 'flat', val: 150, max: 150, min: 500, scope: 'PUJA', pujaId: 'satyanarayan', starts: in5days(), perUser: 2 } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const row = db.prepare("SELECT * FROM coupons WHERE code='PUJAONLY'").get();
  assert.equal(row.scope, 'PUJA');
  assert.equal(row.puja_id, 'satyanarayan');
  assert.equal(row.per_user, 2);
  assert.ok(Math.abs(row.starts - in5daysMs()) < 864e5, 'starts converted to epoch ms');

  /* validation */
  assert.equal((await call('POST', '/admin/coupons', { token: at, body: { code: 'BADSCOPE', type: 'flat', val: 10, scope: 'NRI' } })).status, 400, 'scope whitelist');
  assert.equal((await call('POST', '/admin/coupons', { token: at, body: { code: 'BADPUJA', type: 'flat', val: 10, scope: 'PUJA', pujaId: 'nope' } })).status, 400, 'unknown puja');
  assert.equal((await call('POST', '/admin/coupons', { token: at, body: { code: 'BADWIN', type: 'flat', val: 10, starts: in5days(), expires: in5days() } })).status, 400, 'start must precede expiry');

  const audits = (await call('GET', '/admin/audit?limit=300', { token: at })).json.entries;
  assert.ok(audits.find((a) => a.action === 'coupon.create' && a.entityId === 'PUJAONLY'));

  /* access */
  const ct = await login('customer');
  assert.equal((await call('GET', '/admin/coupons', { token: ct })).status, 403);
  assert.equal((await call('GET', '/admin/coupons')).status, 401);
});

test('scope enforcement: KUNDALI coupon refused on puja booking and cart, accepted on kundali', async () => {
  const at = await admin();
  await call('POST', '/admin/coupons', { token: at, body: { code: 'KundOnly', type: 'flat', val: 50, max: 50, min: 300, scope: 'KUNDALI' } });
  const ct = await login('customer');

  const quoted = await call('POST', '/quote', { token: ct, body: { pujaId: 'satyanarayan', mode: 'home', sam: [], pra: [], coupon: 'KUNDONLY' } });
  assert.equal(quoted.json.couponError, 'This coupon does not apply to this purchase.', 'booking quote refuses KUNDALI scope');

  const booked = await call('POST', '/bookings', { token: ct, body: bookingBody({ coupon: 'KUNDONLY', date: dayPlus(31) }) });
  assert.equal(booked.status, 400);
  assert.equal(booked.json.error, 'This coupon does not apply to this purchase.');

  const cartCheck = await call('POST', '/orders/coupon', { token: ct, body: { code: 'KUNDONLY', items: [{ k: anyKit(), q: 1 }] } });
  assert.equal(cartCheck.status, 200);
  assert.ok(cartCheck.json.problem, 'cart refuses KUNDALI scope');

  /* kundali accepts it — a fresh customer's first personal kundali is FREE
     (plan quota), so burn the quota first to make this one chargeable. */
  const ct2 = await login('customer');
  const places = (await call('GET', '/kundali/places?q=delhi')).json.places;
  for (let i = 0; i < 2; i++) {
    await call('POST', '/kundali/generate', { token: ct2, body: { name: 'Quota ' + i, dob: '1992-03-03', tob: '09:15', placeId: places[i % places.length].id, save: true } });
  }
  const gen = await call('POST', '/kundali/generate', { token: ct2, body: { name: 'Coupon Tester', dob: '1992-03-03', tob: '09:15', placeId: places[0].id, save: true, coupon: 'KundOnly' } });
  assert.equal(gen.status, 201, JSON.stringify(gen.json));
  const kd = db.prepare('SELECT coupon, discount FROM kundalis WHERE id=?').get(gen.json.kundaliId);
  assert.ok(kd, 'kundali row found');
  assert.equal(kd.coupon, 'KUNDONLY');
  assert.ok(kd.discount >= 50, 'coupon discount applied');
  const redemption = db.prepare("SELECT * FROM coupon_redemptions WHERE code='KUNDONLY' AND source='kundali'").get();
  assert.ok(redemption, 'kundali redemption recorded at the money moment');
});

test('validity window + per-user cap: expired refused, cap counted across surfaces', async () => {
  const at = await admin();
  await call('POST', '/admin/coupons', { token: at, body: { code: 'Expired', type: 'flat', val: 100, max: 100, min: 300, expires: ago2daysMs() } });
  await call('POST', '/admin/coupons', { token: at, body: { code: 'TwiceOnly', type: 'flat', val: 20, max: 20, min: 300, perUser: 2 } });
  const ct = await login('customer');

  const qExpired = await call('POST', '/quote', { token: ct, body: { pujaId: 'satyanarayan', mode: 'home', sam: [], pra: [], coupon: 'EXPIRED' } });
  assert.equal(qExpired.json.couponError, 'This coupon has expired.');

  /* redeem TwiceOnly twice via the cart (ALL scope), third order refused */
  db.prepare("UPDATE coupons SET scope='ALL' WHERE code='TWICEONLY'").run();
  const cart = [{ k: anyKit(), q: 1 }];
  const o1 = await call('POST', '/orders', { token: ct, body: { items: cart, address: '12 Test Street', city: 'Delhi NCR', coupon: 'TwiceOnly' } });
  assert.equal(o1.status, 201, JSON.stringify(o1.json));
  assert.ok(o1.json.order.discount >= 20, 'discount stored on the order');
  assert.equal(o1.json.order.coupon, 'TWICEONLY');
  const o2 = await call('POST', '/orders', { token: ct, body: { items: cart, address: '12 Test Street', city: 'Delhi NCR', coupon: 'TWICEONLY' } });
  assert.equal(o2.status, 201);
  const o3 = await call('POST', '/orders', { token: ct, body: { items: cart, address: '12 Test Street', city: 'Delhi NCR', coupon: 'TWICEONLY' } });
  assert.equal(o3.status, 400);
  assert.equal(o3.json.error, 'You have already used this coupon the maximum number of times.');
  const redemptions = db.prepare("SELECT COUNT(*) AS n FROM coupon_redemptions WHERE code='TWICEONLY' AND source='order'").get();
  assert.equal(redemptions.n, 2, 'per-user redemptions tracked at each money moment');
});

test('PUJA-scope coupon: restricted puja enforced, per-puja mismatch refused', async () => {
  const at = await admin();
  await call('POST', '/admin/coupons', { token: at, body: { code: 'SatOnly', type: 'pct', val: 10, max: 200, min: 1000, scope: 'PUJA', pujaId: 'satyanarayan' } });
  const ct = await login('customer');

  const ok = await call('POST', '/quote', { token: ct, body: { pujaId: 'satyanarayan', mode: 'home', sam: [], pra: [], coupon: 'SATONLY' } });
  assert.equal(ok.json.couponError, '', 'matches the restricted puja');

  const other = await call('POST', '/quote', { token: ct, body: { pujaId: 'vivah', mode: 'home', sam: [], pra: [], coupon: 'SATONLY' } });
  assert.equal(other.json.couponError, 'This coupon applies to a different puja.');
});

test('booking redemption recorded; ALL-scope coupon still works on bookings (legacy behaviour)', async () => {
  const ct = await login('customer');
  const b = await call('POST', '/bookings', { token: ct, body: bookingBody({ coupon: 'FIRST100', date: dayPlus(33) }) });
  assert.equal(b.status, 201, JSON.stringify(b.json));
  const redemption = db.prepare("SELECT * FROM coupon_redemptions WHERE source='booking' AND ref_id=?").get(b.json.booking.id);
  assert.ok(redemption, 'booking redemption recorded');
  assert.equal(redemption.code, 'FIRST100');
});
