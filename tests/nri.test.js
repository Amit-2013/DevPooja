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
  /* Phase E follow-up: the demo catalogue is seeded in DEMO_MODE (production
     starts with an empty catalogue, exactly like the footer's social links). */
  const seeded = (await call('GET', '/nri-packages')).json.packages;
  assert.ok(seeded.some((x) => String(x.id).indexOf('nrp-demo') === 0), 'demo NRI packages are seeded');
  assert.ok(seeded.every((x) => ['USD', 'GBP', 'AED', 'INR'].includes(x.currency) && x.price > 0 && x.inrEquiv > 0 && Array.isArray(x.includes) && x.active), 'seeded rows are well-formed and on sale');
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

  /* never sold → deletable; the reason is audited */
  assert.equal((await call('DELETE', '/admin/nri-packages/' + p.id, { token: at, body: { reason: 'Duplicate of the Ganesh combo package' } })).status, 200);
  const audits2 = (await call('GET', '/admin/audit?limit=300', { token: at })).json.entries;
  assert.ok(audits2.find((a) => a.action === 'nri.package_delete' && a.entityId === p.id && (a.reason || '').includes('Duplicate of the Ganesh')));

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

test('NRI gateway payments: checkout holds PENDING with a currency Razorpay order, signature settles PAID + ledger', async () => {
  const at = await admin(), ct = await login('customer');
  const pkg = (await call('POST', '/admin/nri-packages', { token: at, body: { name: 'Abroad Gateway Pack', price: 75, currency: 'GBP', inrEquiv: 8000, includes: ['Puja + prasad'] } })).json.package;

  process.env.PAYMENT_MODE = 'razorpay';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_x';
  process.env.RAZORPAY_KEY_SECRET = 'shh';
  const realFetch = global.fetch;
  global.fetch = (u, o) => String(u).startsWith('https://api.razorpay.com') ? Promise.resolve(new Response(JSON.stringify({ id: 'order_GBP1', amount: 7500, currency: 'GBP' }), { status: 200 })) : realFetch(u, o);
  try {
    /* checkout: PAID is NOT settled in gateway mode; a Razorpay order in the
       package currency comes back for checkout.js */
    const r = await call('POST', '/nri-orders', { token: ct, body: { packageId: pkg.id, idem: 'gw-key-1' } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const o = r.json.order;
    assert.equal(o.status, 'PENDING_PAYMENT', 'gateway checkout holds the order');
    assert.equal(o.currency, 'GBP');
    assert.equal(o.gatewayOrderId, 'order_GBP1');
    assert.equal(r.json.payment.currency, 'GBP', 'checkout opens in the package currency');
    assert.equal(r.json.payment.amount, 7500, '75 GBP = 7500 pence, no conversion');
    assert.equal(r.json.payment.keyId, 'rzp_test_x');
    assert.equal(db.prepare("SELECT status FROM nri_orders WHERE id=?").get(o.id).status, 'PENDING_PAYMENT');
    /* no ledger row for THIS order before the money moment (rows for other
       orders may legitimately exist from earlier tests in this file) */
    assert.ok(!db.prepare("SELECT ref_id FROM transactions WHERE type='NRI_PAYMENT'").all().some((r) => r.ref_id === o.id), 'no ledger row for this order yet');

    /* idempotent replay still returns the original held order (no duplicate) */
    const replay = await call('POST', '/nri-orders', { token: ct, body: { packageId: pkg.id, idem: 'gw-key-1' } });
    assert.equal(replay.json.order.id, o.id);

    /* a bad signature is refused and the order stays pending */
    const badSig = await call('POST', '/nri-orders/' + o.id + '/verify', { token: ct, body: { razorpay_order_id: 'order_GBP1', razorpay_payment_id: 'pay_g1', razorpay_signature: 'deadbeef' } });
    assert.equal(badSig.status, 400);
    assert.match(badSig.json.error, /verification failed/);

    /* a forged gateway order id is refused */
    const forged = await call('POST', '/nri-orders/' + o.id + '/verify', { token: ct, body: { razorpay_order_id: 'order_OTHER', razorpay_payment_id: 'pay_g1', razorpay_signature: 'x' } });
    assert.equal(forged.status, 400);

    /* real signature: HMAC-SHA256(secret, order|payment) settles the order */
    const sig = require('crypto').createHmac('sha256', 'shh').update('order_GBP1|pay_g1').digest('hex');
    const ok = await call('POST', '/nri-orders/' + o.id + '/verify', { token: ct, body: { razorpay_order_id: 'order_GBP1', razorpay_payment_id: 'pay_g1', razorpay_signature: sig } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.status, 'PAID');
    const row = db.prepare('SELECT * FROM nri_orders WHERE id=?').get(o.id);
    assert.equal(row.status, 'PAID');
    assert.equal(row.gateway_payment_id, 'pay_g1');
    assert.equal(row.gateway_order_id, 'order_GBP1');

    /* ledger written exactly once at the money moment, in INR (inr_equiv) */
    const ledger = db.prepare("SELECT * FROM transactions WHERE type='NRI_PAYMENT' AND ref_id=?").all(o.id);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].amount, 8000, 'INR equivalent, not the GBP amount');
    assert.equal(ledger[0].currency, 'INR');

    /* replaying verify is an idempotent no-op (same contract as kundali) */
    const again = await call('POST', '/nri-orders/' + o.id + '/verify', { token: ct, body: { razorpay_order_id: 'order_GBP1', razorpay_payment_id: 'pay_g1', razorpay_signature: sig } });
    assert.equal(again.status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM transactions WHERE type='NRI_PAYMENT' AND ref_id=?").all(o.id).length, 1);

    /* another customer cannot verify someone else's order (demo logins all
       resolve to u1, so a distinct OTP customer is needed) */
    await call('POST', '/auth/otp/send', { body: { mobile: '9811188777' } });
    const other = (await call('POST', '/auth/otp/verify', { body: { mobile: '9811188777', otp: '123456' } })).json.token;
    const o2 = (await call('POST', '/nri-orders', { token: other, body: { packageId: pkg.id, idem: 'gw-key-2' } })).json.order;
    const foreign = await call('POST', '/nri-orders/' + o2.id + '/verify', { token: ct, body: { razorpay_order_id: 'x', razorpay_payment_id: 'y', razorpay_signature: 'z' } });
    assert.equal(foreign.status, 404, 'ownership enforced on verify');
  } finally { global.fetch = realFetch; process.env.PAYMENT_MODE = 'mock'; }
});
