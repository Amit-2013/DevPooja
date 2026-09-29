/* Phase 11: per-mode puja pricing — explicit flat per-mode prices override the
   legacy formula (pf multiplier does not apply), modes restrict bookable puja
   types, admin PATCH accepts both, puja.create/update audited. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-pricing-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const test = require('node:test');
const assert = require('node:assert/strict');
const seedMod = require('../server/seed');
const app = require('../server/index.js');
const P = require('../shared/pricing');

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
const dayPlus = (n) => { const d = new Date(); d.setHours(12); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const bookingBody = (o = {}) => ({ pujaId: 'satyanarayan', mode: 'home', date: dayPlus(20), slot: '10:00 AM', addr: { line: '12 Test Street', city: 'Delhi NCR', pin: '110001' }, sam: [], pra: [], ...o });
const { db } = require('../server/db');

test('pricing engine: flat modePrice overrides the formula; null keeps parity', async () => {
  /* legacy: round(2500 * 1 * 1 / 10) * 10 = 2500 */
  assert.equal(P.quote('home', { puja: { price: 2500 } }).svc, 2500);
  /* flat override ignores the factor: online 0.7 would be 1750, explicit says 1999 */
  assert.equal(P.quote('online', { puja: { price: 2500 }, modePrice: 1999 }).svc, 1999);
  /* pf does not apply to a flat price */
  assert.equal(P.quote('home', { puja: { price: 2500 }, pandit: { pf: 1.5 }, modePrice: 1999 }).svc, 1999);
  assert.equal(P.quote('home', { puja: { price: 2500 }, pandit: { pf: 1.5 } }).svc, 3750);
  /* null behaves exactly like the old engine */
  assert.equal(P.quote('online', { puja: { price: 2500 }, modePrice: null }).svc, P.quote('online', { puja: { price: 2500 } }).svc);
});

test('priceRequest resolves price_{mode} and refuses modes outside the puja list', async () => {
  const ct = await login('customer'), at = await admin();

  /* set an explicit online price + drop 'custom' from satyanarayan's modes */
  const patched = await call('PATCH', '/admin/pujas/satyanarayan', { token: at, body: { priceOnline: 1999, modes: ['home', 'online', 'temple'] } });
  assert.equal(patched.status, 200);

  const qOnline = (await call('POST', '/quote', { token: ct, body: { pujaId: 'satyanarayan', mode: 'online', date: dayPlus(20), slot: '10:00 AM' } })).json.q;
  assert.equal(qOnline.svc, 1999, 'explicit flat online price honoured');

  const qHome = (await call('POST', '/quote', { token: ct, body: { pujaId: 'satyanarayan', mode: 'home', date: dayPlus(20), slot: '10:00 AM' } })).json.q;
  assert.equal(qHome.svc, 2500, 'home still uses the legacy formula');

  /* refused mode */
  const refused = await call('POST', '/quote', { token: ct, body: { pujaId: 'satyanarayan', mode: 'custom', date: dayPlus(20), slot: '10:00 AM' } });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /Customized Puja is not offered for this puja/);

  /* booking through a refused mode fails; through an allowed one prices flat */
  const refusedBooking = await call('POST', '/bookings', { token: ct, body: bookingBody({ mode: 'custom' }) });
  assert.equal(refusedBooking.status, 400);
  const okBooking = await call('POST', '/bookings', { token: ct, body: bookingBody({ mode: 'online', date: dayPlus(21) }) });
  assert.equal(okBooking.status, 201, JSON.stringify(okBooking.json));
  assert.equal(okBooking.json.booking.q.svc, 1999, 'booking carries the flat per-mode price');

  /* clear the override back to the formula */
  const cleared = await call('PATCH', '/admin/pujas/satyanarayan', { token: at, body: { priceOnline: null, modes: ['home', 'online', 'temple', 'custom'] } });
  assert.equal(cleared.status, 200);
  const qBack = (await call('POST', '/quote', { token: ct, body: { pujaId: 'satyanarayan', mode: 'online', date: dayPlus(20), slot: '10:00 AM' } })).json.q;
  assert.equal(qBack.svc, 1750, 'null restores the legacy online price');
  /* serializer exposes the new fields */
  const state = (await call('GET', '/state', { token: ct })).json;
  const sp = state.catalog.pujas.find((x) => x.id === 'satyanarayan');
  assert.equal(sp.priceOnline, null);
  assert.ok(sp.modes.includes('home'));
});

test('puja admin: create + patch audited (puja.create / puja.update), validation', async () => {
  const at = await admin();

  const created = await call('POST', '/admin/pujas', { token: at, body: { name: 'Saraswati Vandana', hindi: 'सरस्वती वंदना', cat: 'Deity Worship', dur: 60, price: 1800, kit: 'k_basic', modes: ['home', 'online'] } });
  assert.equal(created.status, 201, JSON.stringify(created.json));

  const audits = (await call('GET', '/admin/audit?limit=300', { token: at })).json.entries;
  const c = audits.find((a) => a.action === 'puja.create' && a.detail.name === 'Saraswati Vandana');
  assert.ok(c, 'puja.create audited');

  const badModes = await call('PATCH', '/admin/pujas/satyanarayan', { token: at, body: { modes: ['telepathy'] } });
  assert.equal(badModes.status, 400, 'at least one valid mode required');
  const badPrice = await call('PATCH', '/admin/pujas/satyanarayan', { token: at, body: { priceTemple: 10 } });
  assert.equal(badPrice.status, 400, 'per-mode price bounds enforced');

  const upd = await call('PATCH', '/admin/pujas/satyanarayan', { token: at, body: { priceTemple: 2250 } });
  assert.equal(upd.status, 200);
  const audits2 = (await call('GET', '/admin/audit?limit=300', { token: at })).json.entries;
  const u = audits2.find((a) => a.action === 'puja.update' && a.entityId === 'satyanarayan');
  assert.ok(u, 'puja.update audited');
  assert.equal(u.newValue.price, db.prepare('SELECT price FROM pujas WHERE id=?').get('satyanarayan').price);
  assert.equal(db.prepare('SELECT price_temple FROM pujas WHERE id=?').get('satyanarayan').price_temple, 2250, 'per-mode price persisted');
});
