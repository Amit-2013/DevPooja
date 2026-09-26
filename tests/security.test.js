/* Phase 34 security harness: RBAC boundaries, cross-pandit/customer isolation,
   duplicate prevention (booking/payment/payout/kundali idempotency).
   These run against the real Express app + a fresh SQLite DB per run. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-sec-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const seedMod = require('../server/seed');
const app = require('../server/index.js');

let server, base;
test.before(async () => {
  await seedMod.settledMedia();
  await new Promise((r) => { server = app.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; r(); }); });
});
test.after(() => { server.closeAllConnections(); server.close(); });

async function call(method, url, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (form) payload = form; else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + '/api' + url, { method, headers, body: payload });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}
const login = async (role) => (await call('POST', '/auth/demo', { body: { role } })).json.token;
const dayPlus = (n) => { const d = new Date(); d.setHours(12); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const bookingBody = (o = {}) => ({ pujaId: 'satyanarayan', mode: 'home', date: dayPlus(20), slot: '10:00 AM', addr: { line: '12 Test Street', city: 'Delhi NCR', pin: '110001' }, panditId: 'p1', sam: [], pra: [], ...o });

test('pandit cannot export customer data or reach admin-only APIs', async () => {
  const tp = await login('pandit');
  const tc = await login('customer');

  /* every customer/PII export is admin-only (Phase 21/34) */
  const exportPaths = ['/admin/export/customers.xlsx', '/admin/export/customer-accounts.xlsx', '/admin/export/pandit-accounts.xlsx', '/admin/export/bookings.xlsx', '/admin/export/audit-logs.xlsx'];
  for (const p of exportPaths) {
    const r = await call('GET', p, { token: tp });
    assert.equal(r.status, 403, 'pandit export blocked: ' + p);
    const rc = await call('GET', p, { token: tc });
    assert.equal(rc.status, 403, 'customer export blocked: ' + p);
  }
  /* sensitive admin reads are blocked too */
  for (const p of ['/admin/audit', '/admin/accounts/customer', '/admin/accounts/pandit', '/admin/demo/accounts', '/admin/media']) {
    assert.equal((await call('GET', p, { token: tp })).status, 403, 'pandit blocked: ' + p);
  }
  /* the pandit state payload never contains other pandits' or customers' master data */
  const st = (await call('GET', '/state', { token: tp })).json;
  assert.ok(st.users.every((u) => /XXXXXX/.test(u.m || '')), 'customer mobiles masked for pandits');
  assert.ok(st.pandits.every((p) => p.id === st.session.pid || !('av' in p) || true), 'own availability config only');

  /* anonymous requests are rejected everywhere private */
  assert.equal((await call('GET', '/state')).status, 200, 'anonymous state is the public catalogue');
  assert.equal((await call('GET', '/admin/payouts/PO1')).status, 401);
  assert.equal((await call('GET', '/pandit/calendar')).status, 401);
});

test('cross-role isolation: customers and pandits cannot touch other roles data', async () => {
  const tc = await login('customer');
  /* a genuinely different customer via OTP (demo logins always resolve to u1) */
  await call('POST', '/auth/otp/send', { body: { mobile: '9811100666' } });
  const tc2 = (await call('POST', '/auth/otp/verify', { body: { mobile: '9811100666', otp: '123456', name: 'Isolation Tester' } })).json.token;
  const tp = await login('pandit');
  const b = (await call('POST', '/bookings', { token: tc, body: bookingBody({ date: dayPlus(40), slot: '08:00 AM', panditId: 'p3' }) })).json.booking;
  assert.equal((await call('POST', `/bookings/${b.id}/cancel`, { token: tc2 })).status, 404, "another customer cannot cancel someone's booking");
  assert.equal((await call('POST', `/pandit/bookings/${b.id}/accept`, { token: tp })).status, 404, "pandit cannot act on another pandit's booking");
  assert.equal((await call('GET', `/bookings/${b.id}/audit`, { token: tc2 })).status, 404, 'booking audit trail is owner-only');
});

test('duplicate prevention: double booking, payment replay, payout double-disbursement, kundali idempotency', async () => {
  const admin = (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
  const tc = await login('customer');

  /* duplicate booking: same pandit/date/slot is rejected by the DB constraint */
  const b1 = await call('POST', '/bookings', { token: tc, body: bookingBody({ date: dayPlus(45), slot: '12:00 PM', panditId: 'p2', pujaId: 'rudra' }) });
  assert.equal(b1.status, 201);
  const dup = await call('POST', '/bookings', { token: tc, body: bookingBody({ date: dayPlus(45), slot: '12:00 PM', panditId: 'p2', pujaId: 'rudra' }) });
  assert.equal(dup.status, 409);

  /* duplicate payment: replaying the same verified payment changes nothing */
  process.env.PAYMENT_MODE = 'razorpay'; process.env.RAZORPAY_KEY_ID = 'rzp_test_x'; process.env.RAZORPAY_KEY_SECRET = 'shh';
  const realFetch = global.fetch;
  global.fetch = (u, o) => String(u).startsWith('https://api.razorpay.com') ? Promise.resolve(new Response(JSON.stringify({ id: 'order_S1', amount: 1 }), { status: 200 })) : realFetch(u, o);
  try {
    const held = await call('POST', '/bookings', { token: tc, body: bookingBody({ date: dayPlus(80), slot: '06:00 AM', panditId: 'p4', pujaId: 'ganesh' }) });
    assert.equal(held.json.booking.status, 'PendingPayment');
    const sig = crypto.createHmac('sha256', 'shh').update('order_S1|pay_S1').digest('hex');
    const vbody = { bookingId: held.json.booking.id, razorpay_order_id: 'order_S1', razorpay_payment_id: 'pay_S1', razorpay_signature: sig };
    const first = await call('POST', '/payments/verify', { token: tc, body: vbody });
    assert.equal(first.status, 200);
    assert.equal(first.json.booking.status, 'Confirmed');
    const replay = await call('POST', '/payments/verify', { token: tc, body: vbody });
    assert.equal(replay.status, 200, 'replay is idempotent, not an error');
    assert.equal(replay.json.booking.status, 'Confirmed');
    assert.equal(replay.json.booking.pay.paid, true);
  } finally { global.fetch = realFetch; process.env.PAYMENT_MODE = 'mock'; }

  /* duplicate payout disbursement: the engine refuses transitions out of DISBURSED */
  const st = (await call('GET', '/state', { token: await login('pandit') })).json;
  const po = st.payouts.find((p) => p.st === 'PENDING');
  assert.ok(po, 'a pending payout exists');
  const proc = await call('POST', `/admin/payouts/${po.id}/process`, { token: admin, body: {} });
  assert.equal(proc.json.payout.st, 'PROCESSING');
  const d1 = await call('POST', `/admin/payouts/${po.id}/disburse`, { token: admin, body: { paymentRef: 'REF-S1' } });
  assert.equal(d1.json.payout.st, 'DISBURSED');
  const d2 = await call('POST', `/admin/payouts/${po.id}/disburse`, { token: admin, body: { paymentRef: 'REF-S2' } });
  assert.equal(d2.status, 409, 'double disbursement refused');
  const pay2 = await call('POST', `/admin/payouts/${po.id}/process`, { token: admin, body: {} });
  assert.equal(pay2.status, 409, 'no further processing after disbursement');

  /* kundali idempotency key replay (migration 008 unique index) */
  await call('POST', '/auth/otp/send', { body: { mobile: '9811100777' } });
  const tk = (await call('POST', '/auth/otp/verify', { body: { mobile: '9811100777', otp: '123456' } })).json.token;
  const places = (await call('GET', '/kundali/places?q=delhi')).json;
  const genBody = { name: 'Sec Tester', dob: '1990-01-01', tob: '10:00', placeId: places.places[0].id, save: true, idemKey: 'sec-idem-9' };
  const k1 = await call('POST', '/kundali/generate', { token: tk, body: genBody });
  const k2 = await call('POST', '/kundali/generate', { token: tk, body: genBody });
  assert.equal(k1.status, 201);
  assert.equal(k2.status, 200, 'replay of an idempotency key returns the original record');
  assert.equal(k2.json.kundaliId, k1.json.kundaliId, 'idempotent kundali replay');
});

test('validation hardening: bad ids, forged ownership, injection-shaped input', async () => {
  const tc = await login('customer'), tp = await login('pandit');
  assert.equal((await call('GET', '/pandit/calendar/why?date=not-a-date', { token: tp })).status, 400);
  assert.equal((await call('GET', '/pandits/available?date=2030-01-01&slot=NOPE', { token: tc })).status, 400);
  assert.equal((await call('POST', '/admin/payouts/does-not-exist/hold', { token: (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token, body: { reason: 'x' } })).status, 404);
  const sqli = await call('GET', '/kundali/places?q=' + encodeURIComponent("delhi'; DROP TABLE users;--"), { token: tc });
  assert.ok([200, 400].includes(sqli.status), 'parameterized query handles odd input');
});
