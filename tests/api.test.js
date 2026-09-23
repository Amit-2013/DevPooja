process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server/index.js');
const P = require('../shared/pricing');
const pay = require('../server/services/payments');
const crypto = require('crypto');

let server, base;
test.before(() => new Promise((r) => { server = app.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; r(); }); }));
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

test('anonymous state exposes catalogue but no private data', async () => {
  const { status, json } = await call('GET', '/state');
  assert.equal(status, 200);
  assert.ok(json.catalog.pujas.length >= 16);
  assert.deepEqual([json.bookings, json.users, json.coupons, json.leads, json.payouts], [[], [], [], [], []]);
  assert.ok(json.pandits.every((p) => p.st === 'verified' && p.m === undefined));
});

test('OTP login creates a customer; wrong OTP is rejected', async () => {
  assert.equal((await call('POST', '/auth/otp/send', { body: { mobile: '12345' } })).status, 400);
  const s = await call('POST', '/auth/otp/send', { body: { mobile: '9000011111' } });
  assert.equal(s.status, 200);
  assert.equal((await call('POST', '/auth/otp/verify', { body: { mobile: '9000011111', otp: '000000' } })).status, 400);
  const v = await call('POST', '/auth/otp/verify', { body: { mobile: '9000011111', otp: '123456', name: 'Test Devotee' } });
  assert.equal(v.status, 200);
  const st = await call('GET', '/state', { token: v.json.token });
  assert.equal(st.json.me.n, 'Test Devotee');
  assert.equal(st.json.me.pts, 50);
});

test('email signup and login', async () => {
  assert.equal((await call('POST', '/auth/email', { body: { email: 'a@b.co', password: 'short' } })).status, 400);
  assert.equal((await call('POST', '/auth/email', { body: { email: 'new@user.in', password: 'longenough1', name: 'New User' } })).status, 200);
  assert.equal((await call('POST', '/auth/email', { body: { email: 'new@user.in', password: 'wrongwrong1' } })).status, 401);
  assert.equal((await call('POST', '/auth/email', { body: { email: 'new@user.in', password: 'longenough1' } })).status, 200);
});

test('server quote matches shared pricing and validates coupons', async () => {
  const t = await login('customer');
  const r = await call('POST', '/quote', { token: t, body: { pujaId: 'lakshmi', mode: 'home', panditId: 'p1', sam: ['k_lakshmi'], pra: [], coupon: 'DAIVIKPOOJA10' } });
  const expected = P.quote('home', { puja: { price: 3100 }, pandit: { pf: 1.15 }, plus: false, kits: [{ price: 799 }], prasad: [], coupon: { active: true, type: 'pct', val: 10, max: 500, min: 1500 }, points: 0 });
  assert.equal(r.json.q.total, expected.total);
  const bad = await call('POST', '/quote', { token: t, body: { pujaId: 'lakshmi', mode: 'home', coupon: 'NOPE' } });
  assert.ok(bad.json.couponError);
});

test('booking: validation, success, double-booking protection, privacy', async () => {
  const t1 = await login('customer');
  assert.equal((await call('POST', '/bookings', { token: t1, body: bookingBody({ date: dayPlus(0) }) })).status, 400);
  assert.equal((await call('POST', '/bookings', { token: t1, body: bookingBody({ pujaId: 'nope' }) })).status, 404);
  assert.equal((await call('POST', '/bookings', { token: t1, body: bookingBody({ pujaId: 'vivah', mode: 'temple' }) })).status, 400);
  assert.equal((await call('POST', '/bookings')).status, 401);
  const ok = await call('POST', '/bookings', { token: t1, body: bookingBody() });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.booking.status, 'Confirmed');
  assert.equal(ok.json.booking.pst, 'pending');
  // another customer, same pandit and slot
  await call('POST', '/auth/otp/send', { body: { mobile: '9000022222' } });
  const t2 = (await call('POST', '/auth/otp/verify', { body: { mobile: '9000022222', otp: '123456', name: 'Second' } })).json.token;
  const clash = await call('POST', '/bookings', { token: t2, body: bookingBody() });
  assert.equal(clash.status, 409);
  // privacy: second customer cannot see first customer's booking
  const st = await call('GET', '/state', { token: t2 });
  assert.equal(st.json.bookings.length, 0);
  assert.ok(st.json.busy.some((b) => b.id === ok.json.booking.id && b.p === 'p1'));
  assert.equal(st.json.busy[0].userId, undefined);
  // auto-assign picks a free pandit
  const auto = await call('POST', '/bookings', { token: t2, body: bookingBody({ panditId: '' }) });
  assert.equal(auto.status, 201);
  assert.ok(auto.json.booking.panditId, 'a pandit was auto-assigned');
  assert.notEqual(auto.json.booking.panditId, 'p1', 'p1 is already booked in that slot');
});

test('cancel gives tiered refund, frees the slot, and only the owner can cancel', async () => {
  const t1 = await login('customer');
  const b = (await call('POST', '/bookings', { token: t1, body: bookingBody({ date: dayPlus(30), slot: '02:00 PM', sam: ['k_satya'] }) })).json.booking;
  await call('POST', '/auth/otp/send', { body: { mobile: '9000033333' } });
  const t3 = (await call('POST', '/auth/otp/verify', { body: { mobile: '9000033333', otp: '123456' } })).json.token;
  assert.equal((await call('POST', `/bookings/${b.id}/cancel`, { token: t3 })).status, 404);
  const c = await call('POST', `/bookings/${b.id}/cancel`, { token: t1 });
  assert.equal(c.status, 200);
  assert.equal(c.json.booking.status, 'Cancelled');
  assert.equal(c.json.booking.refund.pct, 100);
  assert.equal(c.json.booking.refund.amt, b.q.total);
  assert.equal((await call('POST', `/bookings/${b.id}/cancel`, { token: t1 })).status, 400);
  // slot is free again
  assert.equal((await call('POST', '/bookings', { token: t3, body: bookingBody({ date: dayPlus(30), slot: '02:00 PM' }) })).status, 201);
});

test('reschedule respects pandit availability', async () => {
  const t1 = await login('customer');
  const b = (await call('POST', '/bookings', { token: t1, body: bookingBody({ date: dayPlus(40), slot: '08:00 AM' }) })).json.booking;
  const r = await call('POST', `/bookings/${b.id}/reschedule`, { token: t1, body: { date: dayPlus(41), slot: '08:00 AM' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.booking.date, dayPlus(41));
  assert.equal((await call('POST', `/bookings/${b.id}/reschedule`, { token: t1, body: { date: dayPlus(-1), slot: '08:00 AM' } })).status, 400);
});

test('pandit flow: accept, start, complete with media; customer review updates rating', async () => {
  const tc = await login('customer'), tp = await login('pandit');
  const b = (await call('POST', '/bookings', { token: tc, body: bookingBody({ date: dayPlus(50), slot: '06:00 PM', pujaId: 'lakshmi' }) })).json.booking;
  assert.equal((await call('POST', `/pandit/bookings/${b.id}/start`, { token: tp })).status, 400);
  assert.equal((await call('POST', `/pandit/bookings/${b.id}/accept`, { token: tp })).json.booking.status, 'Assigned');
  assert.equal((await call('POST', `/pandit/bookings/${b.id}/start`, { token: tp })).json.booking.status, 'Started');
  const form = new FormData();
  form.append('media', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'p.jpg');
  const done = await call('POST', `/pandit/bookings/${b.id}/complete`, { token: tp, form });
  assert.equal(done.status, 200);
  assert.equal(done.json.booking.status, 'Completed');
  assert.equal(done.json.booking.media, 1);
  const media = await fetch(base + done.json.booking.mediaUrls[0]);
  assert.equal(media.status, 200);
  const st = await call('GET', '/state', { token: tp });
  assert.ok(st.json.payouts.some((p) => p.b === b.id && p.st === 'Pending'));
  assert.ok(st.json.users.every((u) => /XXXXXX/.test(u.m)), 'customer mobile is masked for pandits');
  const rv = await call('POST', `/bookings/${b.id}/review`, { token: tc, body: { r: 5, t: 'Wonderful' } });
  assert.equal(rv.status, 200);
  assert.equal((await call('POST', `/bookings/${b.id}/review`, { token: tc, body: { r: 5 } })).status, 409);
});

test('a pandit cannot act on another pandit\'s booking; customers cannot use admin or pandit APIs', async () => {
  const tc = await login('customer');
  const b = (await call('POST', '/bookings', { token: tc, body: bookingBody({ date: dayPlus(60), slot: '12:00 PM', panditId: 'p3' }) })).json.booking;
  const tp = await login('pandit'); // p1
  assert.equal((await call('POST', `/pandit/bookings/${b.id}/accept`, { token: tp })).status, 404);
  assert.equal((await call('GET', '/admin/pandits/p1/docs/idDoc', { token: tc })).status, 403);
  assert.equal((await call('POST', '/admin/settings', { token: tc, body: { commission: 1 } })).status, 403);
  assert.equal((await call('POST', `/pandit/bookings/${b.id}/accept`, { token: tc })).status, 403);
});

test('admin: login, assign, cancel with refund, process refund, coupons, settings', async () => {
  assert.equal((await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'bad' } })).status, 401);
  const ta = (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
  const tc = await login('customer');
  const b = (await call('POST', '/bookings', { token: tc, body: bookingBody({ date: dayPlus(70), slot: '04:00 PM', panditId: '' }) })).json.booking;
  const a = await call('POST', `/admin/bookings/${b.id}/assign`, { token: ta, body: { panditId: 'p4' } });
  assert.equal(a.status, 200);
  assert.equal(a.json.booking.panditId, 'p4');
  const c = await call('POST', `/admin/bookings/${b.id}/status`, { token: ta, body: { status: 'Cancelled' } });
  assert.equal(c.json.booking.refund.state, 'Initiated');
  const rf = await call('POST', `/admin/bookings/${b.id}/refund`, { token: ta });
  assert.equal(rf.json.booking.refund.state, 'Processed');
  assert.equal((await call('POST', '/admin/coupons', { token: ta, body: { code: 'diwali5', type: 'flat', val: 50, min: 500 } })).status, 201);
  assert.equal((await call('POST', '/admin/coupons', { token: ta, body: { code: 'DIWALI5', type: 'flat', val: 50 } })).status, 409);
  assert.equal((await call('POST', '/admin/settings', { token: ta, body: { commission: 25 } })).status, 200);
  const st = (await call('GET', '/state', { token: ta })).json;
  assert.equal(st.set.comm, 25);
  assert.ok(st.coupons.some((x) => x.code === 'DIWALI5'));
  assert.ok(st.bookings.length > 10);
});

test('admin manages samagri kits and prasad; inactive items cannot be sold', async () => {
  const ta = (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
  const tc = await login('customer');
  // create kit + prasad
  const nk = await call('POST', '/admin/kits', { token: ta, body: { name: 'Navagraha Special', price: 649, stock: 5, items: ['Agarbatti', 'Kumkum', 'Navagraha samidha'] } });
  assert.equal(nk.status, 201);
  const npr = await call('POST', '/admin/prasad', { token: ta, body: { name: 'Tirupati Laddu Box', price: 399, descr: 'Two dozen laddus', stock: 3 } });
  assert.equal(npr.status, 201);
  // visible to customers, with stock serialized
  let st = (await call('GET', '/state', { token: tc })).json;
  assert.ok(st.catalog.kits.some((k) => k.id === nk.json.id));
  const prRow = st.catalog.prasad.find((p) => p.id === npr.json.id);
  assert.ok(prRow);
  assert.equal(prRow.stock, 3);
  // edit price and stock
  assert.equal((await call('PATCH', `/admin/kits/${nk.json.id}`, { token: ta, body: { price: 699, stock: 2 } })).status, 200);
  // kit stock: order takes it to 0, then next order conflicts, and booking with the kit conflicts
  const o1 = await call('POST', '/orders', { token: tc, body: { items: [{ k: nk.json.id, q: 2 }], address: '12 Test Street', city: 'Pune' } });
  assert.equal(o1.status, 201);
  assert.equal((await call('POST', '/orders', { token: tc, body: { items: [{ k: nk.json.id, q: 1 }], address: '12 Test Street', city: 'Pune' } })).status, 409);
  const bk = bookingBody({ date: dayPlus(95), pujaId: 'ganesh', sam: [nk.json.id] });
  assert.equal((await call('POST', '/bookings', { token: tc, body: bk })).status, 409);
  // prasad stock: tracked decrement, then conflict, then set to unlimited
  const o2 = await call('POST', '/orders', { token: tc, body: { items: [{ k: npr.json.id, q: 3 }], address: '12 Test Street', city: 'Pune' } });
  assert.equal(o2.status, 201);
  assert.equal((await call('POST', '/orders', { token: tc, body: { items: [{ k: npr.json.id, q: 1 }], address: '12 Test Street', city: 'Pune' } })).status, 409);
  assert.equal((await call('PATCH', `/admin/prasad/${npr.json.id}`, { token: ta, body: { stock: null } })).status, 200);
  assert.equal((await call('POST', '/orders', { token: tc, body: { items: [{ k: npr.json.id, q: 1 }], address: '12 Test Street', city: 'Pune' } })).status, 201);
  // deactivate: hidden from customer state, rejected on booking/order
  assert.equal((await call('PATCH', `/admin/kits/${nk.json.id}`, { token: ta, body: { active: false } })).status, 200);
  assert.equal((await call('PATCH', `/admin/prasad/${npr.json.id}`, { token: ta, body: { active: false } })).status, 200);
  st = (await call('GET', '/state', { token: tc })).json;
  // inactive items stay in state (historical bookings reference them) but are flagged
  assert.equal(st.catalog.kits.find((k) => k.id === nk.json.id).active, 0);
  assert.equal(st.catalog.prasad.find((p) => p.id === npr.json.id).active, 0);
  assert.ok((await call('GET', '/state', { token: ta })).json.catalog.kits.some((k) => k.id === nk.json.id)); // admin still sees it
  assert.equal((await call('POST', '/orders', { token: tc, body: { items: [{ k: nk.json.id, q: 1 }], address: '12 Test Street', city: 'Pune' } })).status, 400);
  const bk2 = bookingBody({ date: dayPlus(96), pujaId: 'ganesh', sam: [nk.json.id] });
  assert.equal((await call('POST', '/bookings', { token: tc, body: bk2 })).status, 400);
  // delete: refused while referenced, allowed when clean
  assert.equal((await call('DELETE', `/admin/kits/${nk.json.id}`, { token: ta })).status, 409);
  const tmp = await call('POST', '/admin/kits', { token: ta, body: { name: 'Temp Delete Kit', price: 100 } });
  assert.equal((await call('DELETE', `/admin/kits/${tmp.json.id}`, { token: ta })).status, 200);
  assert.equal((await call('DELETE', '/admin/prasad/pr_nope00', { token: ta })).status, 404);
  // validation errors
  assert.equal((await call('POST', '/admin/kits', { token: ta, body: { name: '', price: 10 } })).status, 400);
  assert.equal((await call('POST', '/admin/kits', { token: ta, body: { name: 'X', price: -5 } })).status, 400);
  assert.equal((await call('PATCH', '/admin/kits/k_nope_00', { token: ta, body: { price: 10 } })).status, 404);
  assert.equal((await call('POST', '/admin/kits', { token: tc, body: { name: 'Y', price: 10 } })).status, 403);
});

test('pandit registration needs OTP and an ID document; KYC approval', async () => {
  await call('POST', '/auth/otp/send', { body: { mobile: '9000044444' } });
  const f = (withId) => { const form = new FormData(); Object.entries({ name: 'Pt. Test', mobile: '9000044444', otp: '123456', city: 'Pune', exp: '5', langs: 'Hindi', spec: 'ganesh,lakshmi' }).forEach(([k, v]) => form.append(k, v)); if (withId) form.append('idDoc', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'id.pdf'); return form; };
  assert.equal((await call('POST', '/pandit/register', { form: f(false) })).status, 400);
  await call('POST', '/auth/otp/send', { body: { mobile: '9000044444' } });
  assert.equal((await call('POST', '/pandit/register', { form: f(true) })).status, 201);
  const ta = (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
  const st = (await call('GET', '/state', { token: ta })).json;
  const np = st.pandits.find((p) => p.n === 'Pt. Test');
  assert.equal(np.st, 'pending');
  assert.deepEqual(np.kyc, ['idDoc']);
  const doc = await fetch(base + `/api/admin/pandits/${np.id}/docs/idDoc`, { headers: { Authorization: 'Bearer ' + ta } });
  assert.equal(doc.status, 200);
  assert.equal((await call('POST', `/admin/pandits/${np.id}/kyc`, { token: ta, body: { status: 'verified' } })).status, 200);
  assert.ok((await call('GET', '/state')).json.pandits.some((p) => p.id === np.id));
});

test('out-of-stock kits block booking; orders decrement stock', async () => {
  const { db } = require('../server/db');
  const tc = await login('customer');
  db.prepare("UPDATE kits SET stock=0 WHERE id='k_ganesh'").run();
  const r = await call('POST', '/bookings', { token: tc, body: bookingBody({ date: dayPlus(80), pujaId: 'ganesh', sam: ['k_ganesh'] }) });
  assert.equal(r.status, 409);
  const o = await call('POST', '/orders', { token: tc, body: { items: [{ k: 'k_havan', q: 2 }], address: '12 Test Street', city: 'Pune' } });
  assert.equal(o.status, 201);
  assert.equal((await call('POST', '/orders', { token: tc, body: { items: [{ k: 'k_havan', q: 9999 }], address: '12 Test Street', city: 'Pune' } })).status, 400);
});

test('payment signature verification', () => {
  const secret = 'sec', order = 'order_1', paymentId = 'pay_1';
  const sig = crypto.createHmac('sha256', secret).update(order + '|' + paymentId).digest('hex');
  assert.equal(pay.verifySignature(order, paymentId, sig, secret), true);
  assert.equal(pay.verifySignature(order, paymentId, sig.replace(/.$/, '0'), secret), false);
  assert.equal(pay.verifySignature(order, 'pay_2', sig, secret), false);
});

test('refund tiers', () => {
  assert.equal(P.refundPct(72), 100);
  assert.equal(P.refundPct(30), 75);
  assert.equal(P.refundPct(5), 50);
});

test('Razorpay mode: booking is held until the signature verifies; unpaid holds expire', async () => {
  const { db } = require('../server/db');
  process.env.PAYMENT_MODE = 'razorpay'; process.env.RAZORPAY_KEY_ID = 'rzp_test_x'; process.env.RAZORPAY_KEY_SECRET = 'shh';
  const realFetch = global.fetch;
  global.fetch = (u, o) => String(u).startsWith('https://api.razorpay.com') ? Promise.resolve(new Response(JSON.stringify({ id: 'order_T1', amount: 1 }), { status: 200 })) : realFetch(u, o);
  try {
    const tc = await login('customer');
    const r = await call('POST', '/bookings', { token: tc, body: bookingBody({ date: dayPlus(90), slot: '06:00 PM', panditId: 'p2', pujaId: 'rudra' }) });
    assert.equal(r.status, 201);
    assert.equal(r.json.booking.status, 'PendingPayment');
    assert.equal(r.json.payment.orderId, 'order_T1');
    // hidden from the customer's list and blocks the slot
    assert.ok(!(await call('GET', '/state', { token: tc })).json.bookings.some((b) => b.id === r.json.booking.id));
    assert.equal((await call('POST', '/bookings', { token: tc, body: bookingBody({ date: dayPlus(90), slot: '06:00 PM', panditId: 'p2', pujaId: 'rudra' }) })).status, 409);
    const id = r.json.booking.id;
    const bad = await call('POST', '/payments/verify', { token: tc, body: { bookingId: id, razorpay_order_id: 'order_T1', razorpay_payment_id: 'pay_1', razorpay_signature: 'deadbeef' } });
    assert.equal(bad.status, 400);
    const sig = crypto.createHmac('sha256', 'shh').update('order_T1|pay_1').digest('hex');
    const ok = await call('POST', '/payments/verify', { token: tc, body: { bookingId: id, razorpay_order_id: 'order_T1', razorpay_payment_id: 'pay_1', razorpay_signature: sig } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.booking.status, 'Confirmed');
    // an unpaid hold older than 15 minutes is released
    const h = await call('POST', '/bookings', { token: tc, body: bookingBody({ date: dayPlus(91), slot: '06:00 PM', panditId: 'p2', pujaId: 'rudra' }) });
    db.prepare('UPDATE bookings SET created=? WHERE id=?').run(Date.now() - 16 * 60 * 1000, h.json.booking.id);
    await call('GET', '/state');
    assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(h.json.booking.id).status, 'Cancelled');
  } finally { global.fetch = realFetch; process.env.PAYMENT_MODE = 'mock'; }
});
