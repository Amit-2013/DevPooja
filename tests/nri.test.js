/* Phase 13: NRI packages — admin CRUD (deactivate-not-delete once sold),
   public catalogue, idempotent checkout in package currency with the INR
   equivalent hitting the ledger exactly once (NRI_PAYMENT), access control. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-nri-'));
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

test('NRI admin CRUD: create, edit, audits, delete protection', async () => {
  const at = await admin();
  const created = await call('POST', '/admin/nri-packages', { token: at, body: { name: 'Satyanarayan from abroad', descr: 'Full katha for your family back home.', price: 199, currency: 'USD', inrEquiv: 17000, includes: ['Full puja by a verified pandit', 'Photos and video dispatch', 'Prasad delivered to your family'] } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const p = created.json.package;
  assert.equal(p.currency, 'USD');
  assert.deepEqual(p.includes, ['Full puja by a verified pandit', 'Photos and video dispatch', 'Prasad delivered to your family']);

  /* validation */
  assert.equal((await call('POST', '/admin/nri-packages', { token: at, body: { name: 'x', price: 100, currency: 'BTC', inrEquiv: 1 } })).status, 400, 'currency whitelist');
  assert.equal((await call('POST', '/admin/nri-packages', { token: at, body: { name: 'x', price: 0, currency: 'USD', inrEquiv: 1 } })).status, 400, 'positive price');

  const patched = await call('PATCH', '/admin/nri-packages/' + p.id, { token: at, body: { price: 249, active: false } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.package.price, 249);
  assert.equal(patched.json.package.active, false);

  const audits = (await call('GET', '/admin/audit?limit=300', { token: at })).json.entries;
  assert.ok(audits.find((a) => a.action === 'nri.package_create' && a.entityId === p.id));
  assert.ok(audits.find((a) => a.action === 'nri.package_update' && a.entityId === p.id));

  /* never sold → deletable */
  assert.equal((await call('DELETE', '/admin/nri-packages/' + p.id, { token: at })).status, 200);
  const audits2 = (await call('GET', '/admin/audit?limit=300', { token: at })).json.entries;
  assert.ok(audits2.find((a) => a.action === 'nri.package_delete' && a.entityId === p.id));

  /* access */
  const ct = await login('customer');
  assert.equal((await call('POST', '/admin/nri-packages', { token: ct, body: { name: 'x', price: 9, currency: 'USD' } })).status, 403);
});

test('NRI checkout: package currency, INR ledger once, idempotent, delisted refused', async () => {
  const at = await admin(), ct = await login('customer');
  const pkg = (await call('POST', '/admin/nri-packages', { token: at, body: { name: 'Ganesh from abroad', price: 149, currency: 'USD', inrEquiv: 12700, includes: ['Puja + prasad'] } })).json.package;

  const public1 = (await call('GET', '/nri-packages')).json;
  assert.ok(public1.packages.some((x) => x.id === pkg.id), 'public catalogue serves the package');

  const r1 = await call('POST', '/nri-orders', { token: ct, body: { packageId: pkg.id, idem: 'order-key-1' } });
  assert.equal(r1.status, 201, JSON.stringify(r1.json));
  const o = r1.json.order;
  assert.equal(o.amount, 149);
  assert.equal(o.currency, 'USD');
  assert.equal(o.inrEquiv, 12700);
  assert.equal(o.status, 'PAID', 'mock mode marks the order paid immediately');

  /* retry with the same key returns the SAME order — no double sale */
  const r2 = await call('POST', '/nri-orders', { token: ct, body: { packageId: pkg.id, idem: 'order-key-1' } });
  assert.equal(r2.status, 201);
  assert.equal(r2.json.order.id, o.id, 'idempotent replay returns the original order');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM nri_orders').get().c, 1, 'exactly one order row');

  /* one ledger row, in INR (inr_equiv), deduped on retry */
  const ledger = db.prepare("SELECT * FROM transactions WHERE type='NRI_PAYMENT' AND ref_id=?").all(o.id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].amount, 12700, 'ledger carries the INR equivalent');
  assert.equal(ledger[0].currency, 'INR');

  /* delisted packages refuse checkout */
  await call('PATCH', '/admin/nri-packages/' + pkg.id, { token: at, body: { active: false } });
  const refused = await call('POST', '/nri-orders', { token: ct, body: { packageId: pkg.id, idem: 'order-key-2' } });
  assert.equal(refused.status, 404, 'delisted package refused');

  /* a sold package cannot be deleted */
  await call('PATCH', '/admin/nri-packages/' + pkg.id, { token: at, body: { active: true } });
  const del = await call('DELETE', '/admin/nri-packages/' + pkg.id, { token: at });
  assert.equal(del.status, 400);
  assert.match(del.json.error, /Deactivate it instead/);

  /* missing idem key rejected */
  assert.equal((await call('POST', '/nri-orders', { token: ct, body: { packageId: pkg.id } })).status, 400);

  /* customer sees only their own orders; anonymous catalogue is fine, checkout is not */
  const mine = (await call('GET', '/nri-orders', { token: ct })).json.orders;
  assert.ok(mine.some((x) => x.id === o.id));
  assert.equal((await call('GET', '/nri-orders')).status, 401);
  assert.equal((await call('POST', '/nri-orders', { body: { packageId: pkg.id, idem: 'anon' } })).status, 401);
});
