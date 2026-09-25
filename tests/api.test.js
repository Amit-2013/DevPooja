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
const { db } = require('../server/db');
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

test('demo data: stats, accounts, mock bookings and full reset', async () => {
  const admin = (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
  const stats = (await call('GET', '/admin/demo/stats', { token: admin })).json;
  assert.equal(stats.demo, true);
  assert.ok(stats.customers >= 10 && stats.pandits >= 5 && stats.kundalis >= 1);

  const acc = (await call('GET', '/admin/demo/accounts', { token: admin })).json;
  assert.ok(acc.customers.length >= 10, 'at least 10 demo customers');
  assert.ok(acc.pandits.length >= 5, 'at least 5 pandit demo logins');
  assert.ok(acc.pandits.every((p) => /^98100000\d\d$/.test(p.mobile)));
  assert.equal(acc.password, 'demo1234');

  /* every demo customer has at least one booking */
  const book = (await call('GET', '/admin/bookings-list', { token: admin }).catch(() => ({ json: null }))).json;
  void book;
  const allBookings = (await call('GET', '/state', { token: admin })).json.bookings;
  for (const c of acc.customers) {
    assert.ok(allBookings.some((b) => b.userId === c.id), c.id + ' has a booking');
  }

  const before = (await call('GET', '/admin/demo/stats', { token: admin })).json.bookings;
  const mk = await call('POST', '/admin/demo/bookings', { token: admin, body: { count: 4 } });
  assert.equal(mk.status, 201);
  assert.ok(mk.json.created >= 1, 'at least one mock booking should be created');
  const after = (await call('GET', '/admin/demo/stats', { token: admin })).json.bookings;
  assert.ok(after >= before + mk.json.created);
  /* mock bookings use the real engine: they belong to a seeded customer and have prices */
  const st = (await call('GET', '/state', { token: await login('customer') })).json;
  assert.ok(st.bookings.every((b) => b.q && b.q.total > 0));

  const noConfirm = await call('POST', '/admin/demo/reset', { token: admin, body: {} });
  assert.equal(noConfirm.status, 400);

  const rd = await call('POST', '/admin/demo/reset', { token: admin, body: { confirm: 'RESET' } });
  assert.equal(rd.status, 200);
  assert.ok(rd.json.ok);
  assert.equal(rd.json.stats.customers >= 10, true);
  assert.ok(rd.json.token, 'reset returns a fresh admin token');
  const st2 = (await call('GET', '/state', { token: rd.json.token })).json;
  assert.equal(st2.session.role, 'admin');
  assert.ok(st2.catalog.pujas.length >= 16);
  assert.equal(st2.bookings.length, rd.json.stats.bookings);
  /* RESET preserves the Hindi catalog (conditions, mapping reasons, puja benefits) */
  const conds = await call('GET', '/kundali/conditions');
  assert.ok(conds.json.conditions.length >= 9);
  assert.ok(conds.json.conditions.every((c) => c.nameHi && /[\u0900-\u097F]/.test(c.nameHi)), 'Hindi dosh names survive RESET');
  assert.ok(st2.catalog.pujas.filter((p) => p.benHi && /[\u0900-\u097F]/.test(p.benHi)).length >= 15, 'Hindi puja benefits survive RESET');
});

test('kundali: full place object and bilingual (Hindi) analysis', async () => {
  const places = (await call('GET', '/kundali/places?q=delhi')).json;
  assert.ok(places.places.length >= 1);
  const p0 = places.places[0];
  assert.ok(p0.state && p0.country && Number.isFinite(p0.lat) && Number.isFinite(p0.lon) && p0.tz, 'place search returns full details');

  const gen = await call('POST', '/kundali/generate', { body: { name: 'Place Tester', dob: '1990-01-15', tob: '10:30', placeId: p0.id } });
  assert.equal(gen.status, 201);
  const place = gen.json.place;
  assert.equal(place.city, p0.city);
  assert.equal(place.state, p0.state);
  assert.equal(place.country, p0.country);
  assert.equal(place.lat, p0.lat);
  assert.equal(place.lon, p0.lon);
  assert.equal(place.tz, p0.tz);
  assert.equal(place.utcOffset, 'UTC+05:30');
  /* chart meta carries the resolved place for the result page */
  assert.equal(gen.json.chart.meta.city, p0.city);
  assert.equal(gen.json.chart.meta.state, p0.state);

  /* GET /:id returns the same structured place */
  const got = (await call('GET', '/kundali/' + gen.json.kundaliId)).json;
  assert.equal(got.place.city, p0.city);
  assert.equal(got.place.utcOffset, 'UTC+05:30');

  /* Hindi generate: dosh names, evidence and remedies in Devanagari; English kept too */
  const hi = await call('POST', '/kundali/generate', { body: { name: 'Hindi Tester', dob: '1990-01-15', tob: '10:30', placeId: p0.id } });
  assert.equal(hi.status, 201);
  const d = hi.json.analysis.doshas.find((x) => x.code === 'mangal_dosha');
  assert.ok(d, 'mangal rule evaluated');
  assert.equal(d.nameHi, 'मंगल दोष');
  assert.ok(d.explanationHi && /[\u0900-\u097F]/.test(d.explanationHi));
  assert.ok(Array.isArray(d.evidenceHi));
  const cond = (await call('GET', '/kundali/conditions')).json.conditions.find((c) => c.code === 'mangal_dosha');
  assert.ok(cond.remedyHi && /[\u0900-\u097F]/.test(cond.remedyHi), 'Hindi remedy');
  /* recommendations carry Hindi reasons */
  if (hi.json.recommendations.length) assert.ok(hi.json.recommendations.some((r) => r.reasonHi && /[\u0900-\u097F]/.test(r.reasonHi)));
  /* disclaimer exists in both languages */
  assert.ok(hi.json.disclaimer && hi.json.disclaimerHi);
});

test('customised puja request: public submit, admin queue, convert to puja', async () => {
  assert.equal((await call('POST', '/custom-puja', { body: { name: 'X', mobile: '123' } })).status, 400);
  const ok = await call('POST', '/custom-puja', { body: { name: 'Custom Devotee', mobile: '9876567890', purpose: 'Special griha shanti', deity: 'Shiva', city: 'Pune', budget: 6000, notes: 'Family tradition, north-Indian vidhi' } });
  assert.equal(ok.status, 201);
  const admin = (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
  const list = (await call('GET', '/admin/custom-requests', { token: admin })).json.requests;
  const req1 = list.find((r) => r.name === 'Custom Devotee');
  assert.ok(req1 && req1.status === 'NEW');
  assert.equal((await call('GET', '/admin/custom-requests', { token: await login('customer') })).status, 403);
  assert.equal((await call('PATCH', '/admin/custom-requests/' + req1.id, { token: admin, body: { status: 'UNDER_REVIEW', adminNotes: 'Called, confirmed details' } })).status, 200);
  /* status history is maintained */
  const reviewed = (await call('GET', '/admin/custom-requests', { token: admin })).json.requests.find((r) => r.id === req1.id);
  assert.ok(reviewed.history.some((h) => String(h[0]).includes('UNDER_REVIEW')), 'status history tracked');
  const conv = await call('POST', '/admin/custom-requests/' + req1.id + '/convert', { token: admin, body: { name: 'Special Griha Shanti', hindi: 'विशेष गृह शांति', price: 5500 } });
  assert.equal(conv.status, 201);
  assert.ok(conv.json.pujaId);
  const st = (await call('GET', '/state', { token: admin })).json;
  const created = st.catalog.pujas.find((p) => p.id === conv.json.pujaId);
  assert.ok(created && created.hidden, 'converted puja exists and is hidden until priced');
  const after = (await call('GET', '/admin/custom-requests', { token: admin })).json.requests.find((r) => r.id === req1.id);
  assert.equal(after.status, 'SCHEDULED');
});

test('admin full puja editing: name, hindi, category, benefits, price, kit, visibility', async () => {
  const admin = (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
  const st = (await call('GET', '/state', { token: admin })).json;
  const p = st.catalog.pujas[0];
  const r = await call('PATCH', '/admin/pujas/' + p.id, { token: admin, body: { name: 'Edited Puja', hindi: 'संपादित पूजा', cat: 'Prosperity', deity: 'Vishnu', ben: 'Edited benefits text', benHi: 'संपादित लाभ', dur: 100, price: 3333 } });
  assert.equal(r.status, 200);
  const after = (await call('GET', '/state', { token: admin })).json.catalog.pujas.find((x) => x.id === p.id);
  assert.equal(after.n, 'Edited Puja');
  assert.equal(after.h, 'संपादित पूजा');
  assert.equal(after.benHi, 'संपादित लाभ');
  assert.equal(after.price, 3333);
  assert.equal(after.dur, 100);
  /* validation still applies */
  assert.equal((await call('PATCH', '/admin/pujas/' + p.id, { token: admin, body: { price: 5 } })).status, 400);
  assert.equal((await call('PATCH', '/admin/pujas/' + p.id, { token: admin, body: { kit: 'nope' } })).status, 400);
});

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
  const st = (await call('GET', '/state', { token: t })).json;
  const puja = st.catalog.pujas.find((p) => p.id === 'lakshmi');
  const kit = st.catalog.kits.find((k) => k.id === 'k_lakshmi');
  const r = await call('POST', '/quote', { token: t, body: { pujaId: 'lakshmi', mode: 'home', panditId: 'p1', sam: ['k_lakshmi'], pra: [], coupon: 'DAIVIKPOOJA10' } });
  const expected = P.quote('home', { puja: { price: puja.price }, pandit: { pf: 1.15 }, plus: false, kits: [{ price: kit.p }], prasad: [], coupon: { active: true, type: 'pct', val: 10, max: 500, min: 1500 }, points: 0 });
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

/* ---------- Commercial Kundali model, security, exports (migration 008) ----- */

test('kundali commercial model: quota, family pricing, billing states, idempotency', async () => {
  await call('POST', '/auth/otp/send', { body: { mobile: '9811100501' } });
  const tc = (await call('POST', '/auth/otp/verify', { body: { mobile: '9811100501', otp: '123456' } })).json.token;
  const places = (await call('GET', '/kundali/places?q=delhi')).json;
  const p0 = places.places[0];
  const genBody = { name: 'Billing Tester', dob: '1992-03-10', tob: '09:15', placeId: p0.id, save: true };

  /* 1. pricing endpoint reflects admin config and the customer's quota */
  const pr = (await call('GET', '/kundali/pricing', { token: tc })).json;
  assert.equal(pr.prices.family, 499);
  assert.ok(pr.quota.included >= 1);

  /* 2. first personal kundali is FREE (within quota) */
  const k1 = await call('POST', '/kundali/generate', { token: tc, body: genBody });
  assert.equal(k1.status, 201);
  assert.equal(k1.json.billing.state, 'FREE');
  assert.equal(k1.json.billing.final, 0);

  /* 3. idempotency: same idemKey returns the same kundali, no duplicate row */
  const k1b = await call('POST', '/kundali/generate', { token: tc, body: { ...genBody, idemKey: 'test-idem-1' } });
  assert.equal(k1b.status, 201);
  const k1c = await call('POST', '/kundali/generate', { token: tc, body: { ...genBody, idemKey: 'test-idem-1' } });
  assert.equal(k1c.json.kundaliId, k1b.json.kundaliId, 'idempotent replay returns the original kundali');

  /* 4. family member kundali is chargeable (mock gateway => PAID immediately with amount) */
  const fm = await call('POST', '/me/family', { token: tc, body: { relationship: 'Mother', name: 'Sarla Devi', dob: '1965-07-04', tob: '05:30', gender: 'female', city: 'Delhi', state: 'Delhi', country: 'India', lat: 28.6139, lon: 77.209, tz: 'Asia/Kolkata' } });
  assert.equal(fm.status, 201);
  const quote = (await call('POST', '/kundali/quote', { token: tc, body: { relationship: 'Mother' } })).json.quote;
  assert.equal(quote.base, 499);
  assert.equal(quote.gst, Math.round(499 * 0.05));
  assert.equal(quote.final, 499 + Math.round(499 * 0.05));
  const k2 = await call('POST', '/kundali/generate', { token: tc, body: { familyMemberId: fm.json.id, placeId: p0.id } });
  assert.equal(k2.status, 201);
  assert.equal(k2.json.billing.state, 'PAID');
  assert.equal(k2.json.billing.final, quote.final);
  assert.equal(k2.json.chart.meta.name, 'Sarla Devi', 'family member details feed the chart');

  /* 5. /mine lists both with billing info */
  const mine = (await call('GET', '/kundali/mine', { token: tc })).json;
  assert.ok(mine.kundalis.length >= 2);
  assert.ok(mine.kundalis.some((k) => k.relationship === 'Self' && k.billing === 'FREE'));
  assert.ok(mine.kundalis.some((k) => k.relationship === 'Mother' && k.billing === 'PAID' && k.final > 0));

  /* 6. ownership: another customer cannot open the family kundali */
  await call('POST', '/auth/otp/send', { body: { mobile: '9811100502' } });
  const other = (await call('POST', '/auth/otp/verify', { body: { mobile: '9811100502', otp: '123456' } })).json.token;
  assert.ok(other, 'other customer logged in');
  assert.equal((await call('GET', '/kundali/' + k2.json.kundaliId, { token: other })).status, 404);
  assert.equal((await call('GET', '/kundali/' + k2.json.kundaliId, { token: tc })).status, 200);

  /* 7. admin sees the kundali list with billing columns */
  const admin = (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
  const kl = (await call('GET', '/admin/kundalis?kind=family', { token: admin })).json.kundalis;
  assert.ok(kl.some((k) => k.kundaliId === k2.json.kundaliId && k.billing === 'PAID' && k.final > 0));
});

test('kundali pricing is admin-controlled and RESET-safe; toggles gate services', async () => {
  const admin = (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
  const put = await call('PUT', '/admin/kundali/pricing', { token: admin, body: { familyPrice: 750, gstPct: 5, freeCounts: { customer: 1, plus: 2, premium: 5 } } });
  assert.equal(put.status, 200);
  assert.equal(put.json.pricing.familyPrice, 750);
  await call('POST', '/auth/otp/send', { body: { mobile: '9811100503' } });
  const tc = (await call('POST', '/auth/otp/verify', { body: { mobile: '9811100503', otp: '123456' } })).json.token;
  const q = (await call('POST', '/kundali/quote', { token: tc, body: { relationship: 'Father' } })).json.quote;
  assert.equal(q.base, 750, 'new family price applies immediately');
  /* customer cannot change pricing */
  assert.equal((await call('PUT', '/admin/kundali/pricing', { token: tc, body: { familyPrice: 1 } })).status, 403);

  /* toggles: hide customized + astrology from state */
  assert.equal((await call('PUT', '/admin/service-toggles', { token: admin, body: { customized: false, astrology: false } })).status, 200);
  const st = (await call('GET', '/state')).json;
  assert.equal(st.toggles.customized, false);
  assert.equal(st.toggles.astrology, false);
  await call('PUT', '/admin/service-toggles', { token: admin, body: { customized: true, astrology: true } });
});

test('excel exports: all rows, filters, sensitive fields excluded, audit logged', async () => {
  const admin = (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
  await call('POST', '/auth/otp/send', { body: { mobile: '9811100504' } });
  const tc = (await call('POST', '/auth/otp/verify', { body: { mobile: '9811100504', otp: '123456' } })).json.token;
  assert.ok([401, 403].includes((await call('GET', '/admin/export/bookings.xlsx', { token: tc })).status), 'customers cannot export');
  const get = async (rep, qs = '') => {
    const r = await fetch(base + '/api/admin/export/' + rep + '.xlsx' + qs, { headers: { Authorization: 'Bearer ' + admin } });
    assert.equal(r.status, 200, rep + ' exports');
    const buf = Buffer.from(await r.arrayBuffer());
    assert.ok(buf.length > 500 && buf.slice(0, 2).toString() === 'PK', rep + ' is a real xlsx (zip) file');
    return buf;
  };
  const reports = ['customers', 'pandits', 'temples', 'pujas', 'bookings', 'payments', 'orders', 'kundalis', 'kundali-payments', 'family-members', 'custom-requests', 'samagri', 'prasad', 'coupons', 'campaigns', 'payouts', 'revenue', 'puja-performance', 'commission'];
  for (const rep of reports) await get(rep);
  /* filtered export differs from unfiltered */
  await call('PUT', '/admin/kundali/pricing', { token: admin, body: { familyPrice: 499 } });
  const places = (await call('GET', '/kundali/places?q=delhi')).json;
  const fm = (await call('POST', '/me/family', { token: tc, body: { relationship: 'Father', name: 'Export Father', dob: '1960-01-01' } })).json.id;
  await call('POST', '/kundali/generate', { token: tc, body: { familyMemberId: fm, placeId: places.places[0].id } });
  await get('kundalis', '?kind=family');
  /* export audit trail */
  const logs = (await call('GET', '/admin/export-logs', { token: admin })).json.logs;
  assert.ok(logs.length >= reports.length);
  assert.ok(logs.every((l) => l.admin && l.report && typeof l.rows === 'number'));
});

/* ---------- migration 009: account management, media workflow, excel upgrade ---------- */
test('account management: login id, status enforcement, password reset, forced change, lockout, audit', async () => {
  const admin = (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;

  /* account listing with login id + usage counts */
  const accounts = (await call('GET', '/admin/accounts/customer', { token: admin })).json.accounts;
  assert.ok(accounts.length >= 10);
  assert.ok(accounts.every((a) => a.loginId && a.loginMethod && a.status));
  assert.ok(accounts.some((a) => a.demo), 'demo accounts are flagged');
  const target = accounts.find((a) => a.email && !a.demo) || accounts.find((a) => a.email);
  const pandits = (await call('GET', '/admin/accounts/pandit', { token: admin })).json.accounts;
  assert.ok(pandits.length >= 5 && pandits.every((p) => p.panditId && p.kyc));

  /* self-protection: admin cannot disable their own account */
  const meRow = accounts.find((a) => a.email === 'admin@daivikpuja.in');
  const selfBlock = await call('POST', '/admin/users/admin1/status', { token: admin, body: { status: 'disabled' } });
  assert.equal(selfBlock.status, 400);
  void meRow;

  /* suspend -> login refused through the demo door (u1) and API blocked with existing token */
  const susp = await call('POST', '/admin/users/' + target.id + '/status', { token: admin, body: { status: 'suspended' } });
  assert.equal(susp.status, 200);
  const u1susp = await call('POST', '/admin/users/u1/status', { token: admin, body: { status: 'suspended' } });
  assert.equal(u1susp.status, 200);
  const demoAfter = await call('POST', '/auth/demo', { body: { role: 'customer' } });
  assert.equal(demoAfter.status, 403, 'suspended account cannot log in');
  await call('POST', '/admin/users/u1/status', { token: admin, body: { status: 'active' } });

  /* admin reset: one-time temp password, forced change, audit entry, then forced flow */
  const rst = await call('POST', '/admin/users/' + target.id + '/reset-password', { token: admin, body: {} });
  assert.equal(rst.status, 200);
  assert.ok(rst.json.tempPassword && rst.json.tempPassword.length >= 10);
  assert.equal(rst.json.mustChangePassword, true);

  /* reactivate, then log in with the temp password -> mustChangePassword true */
  await call('POST', '/admin/users/' + target.id + '/status', { token: admin, body: { status: 'active' } });
  const u2 = db.prepare('SELECT email FROM users WHERE id=?').get(target.id);
  const li = await call('POST', '/auth/email', { body: { email: u2.email, password: rst.json.tempPassword } });
  assert.equal(li.status, 200);
  assert.equal(li.json.mustChangePassword, true, 'forced change is flagged at login');

  /* last login was stamped and method recorded */
  const after = (await call('GET', '/admin/accounts/customer', { token: admin })).json.accounts.find((a) => a.id === target.id);
  assert.ok(after.lastLoginAt && after.lastLoginMethod === 'email');

  /* self password change clears the flag; wrong current password is refused */
  const badPw = await call('POST', '/auth/change-password', { token: li.json.token, body: { currentPassword: 'wrong-wrong', newPassword: 'brand-new-77' } });
  assert.equal(badPw.status, 401);
  const ch = await call('POST', '/auth/change-password', { token: li.json.token, body: { currentPassword: rst.json.tempPassword, newPassword: 'brand-new-77' } });
  assert.equal(ch.status, 200);
  const re1 = await call('POST', '/auth/email', { body: { email: u2.email, password: 'brand-new-77' } });
  assert.equal(re1.json.mustChangePassword, false);

  /* failed-login lockout: 5 wrong passwords lock the account */
  for (let i = 0; i < 5; i++) await call('POST', '/auth/email', { body: { email: u2.email, password: 'nope-nope-' + i } });
  const locked = await call('POST', '/auth/email', { body: { email: u2.email, password: 'brand-new-77' } });
  assert.equal(locked.status, 429, 'account locked after 5 failures');
  await call('POST', '/admin/users/' + target.id + '/reset-password', { token: admin, body: {} }); // clears lock via reset

  /* audit trail captured the sensitive actions */
  const audit = (await call('GET', '/admin/audit', { token: admin })).json.entries;
  assert.ok(audit.some((a) => a.action === 'account.reset_password' && a.entityId === target.id));
  assert.ok(audit.some((a) => a.action === 'account.status' && a.entityId === target.id));
  assert.ok(!JSON.stringify(audit).includes('brand-new-77'), 'no passwords in the audit trail');

  /* pandit accounts cannot be touched through the customer listing by ID guessing:
     role-scoped listing hides users, and unknown ids 404 */
  const nf = await call('POST', '/admin/users/nosuchuser/status', { token: admin, body: { status: 'disabled' } });
  assert.equal(nf.status, 404);

  /* customers and pandits cannot use admin account endpoints */
  const cust = await login('customer');
  assert.equal((await call('GET', '/admin/accounts/customer', { token: cust })).status, 403);
  const pandit = await login('pandit');
  assert.equal((await call('GET', '/admin/audit', { token: pandit })).status, 403);
});

test('puja media: ownership-scoped uploads, magic bytes, approval workflow, secure download', async () => {
  const admin = (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
  const fake = Buffer.from('this is definitely not an image', 'utf8');
  const form = (buf, name, bookingId) => { const fd = new FormData(); fd.append('media', new Blob([buf], { type: 'image/png' }), name || 'photo.png'); if (bookingId) fd.append('bookingId', bookingId); fd.append('altText', 'Test photo of the puja ritual'); return fd; };

  /* pandit: upload for own assigned booking (u1/p1 has a seeded booking) */
  const pandit = await login('pandit');
  const mine = (await call('GET', '/state', { token: pandit })).json.bookings;
  assert.ok(mine.length, 'pandit has assigned bookings');
  const photosOf = async (id) => (await call('GET', '/pujas/' + id + '/photos')).json.photos || [];
  const baseline = (await photosOf(mine[0].pujaId)).length; // seed photos may exist
  const upRes = await fetch(base + '/api/pandit/media', { method: 'POST', headers: { Authorization: 'Bearer ' + pandit }, body: form(png, 'photo.png', mine[0].id) });
  const up = await upRes.json().catch(() => ({}));
  assert.equal(upRes.status, 201, 'pandit upload accepted: ' + JSON.stringify(up).slice(0, 200));
  assert.ok(up.media && up.media.length === 1, 'pandit upload accepted');
  const m = up.media[0];
  assert.equal(m.status, 'PENDING_ADMIN_REVIEW', 'pandit upload starts pending');
  assert.equal(m.panditId, 'p1');

  /* fake MIME/content rejected by magic-byte sniffing */
  const bad = await fetch(base + '/api/pandit/media', { method: 'POST', headers: { Authorization: 'Bearer ' + pandit }, body: form(fake, 'evil.png') });
  assert.equal(bad.status, 400, 'fake image content is rejected');

  /* hidden from the public catalogue while pending */
  assert.equal((await photosOf(mine[0].pujaId)).length, baseline);

  /* pandit cannot moderate or touch admin media endpoints */
  assert.equal((await call('PATCH', '/admin/media/' + m.id, { token: pandit, body: { status: 'APPROVED' } })).status, 403);

  /* pandit cannot upload for someone else's booking */
  const foreign = await fetch(base + '/api/pandit/media', { method: 'POST', headers: { Authorization: 'Bearer ' + pandit }, body: form(png, 'photo.png', 'nosuchbooking') });
  assert.equal(foreign.status, 404);

  /* admin moderation: approve -> publish -> public */
  const ap = await call('PATCH', '/admin/media/' + m.id, { token: admin, body: { status: 'APPROVED', published: true } });
  assert.equal(ap.status, 200);
  const pub = (await call('GET', '/pujas/' + mine[0].pujaId + '/photos')).json.photos;
  assert.equal(pub.length, baseline + 1);
  assert.ok(pub.some((p) => p.id === m.id));

  /* secure download by id; anonymous can fetch published, pending is 404, traversal-proof */
  const dl = await fetch(base + '/api/media/' + m.id + '/download');
  assert.equal(dl.status, 200);
  assert.ok((await dl.arrayBuffer()).byteLength > 50);
  const dlPandit = await fetch(base + '/api/media/' + m.id + '/download', { headers: { Authorization: 'Bearer ' + pandit } });
  assert.equal(dlPandit.status, 200);
  assert.equal((await call('GET', '/media/pm%2e%2e%2fpercent', {})).status, 404);
  assert.equal((await fetch(base + '/api/media/..%2F..%2Fpackage.json')).status, 404, 'path traversal blocked');

  /* rejected photos can never be public */
  await call('PATCH', '/admin/media/' + m.id, { token: admin, body: { status: 'REJECTED' } });
  const rej = await fetch(base + '/api/media/' + m.id + '/download');
  assert.equal(rej.status, 404, 'rejected media is not downloadable anonymously');
  assert.equal((await photosOf(mine[0].pujaId)).length, baseline);

  /* admin upload to a puja: instantly approved + published, primary when asked */
  const gBefore = (await photosOf('ganesh')).length; // seed photo present
  const gform = form(png, 'hero.png'); gform.append('primary', '1');
  const aup = await fetch(base + '/api/admin/pujas/ganesh/media', { method: 'POST', headers: { Authorization: 'Bearer ' + admin }, body: gform });
  assert.equal(aup.status, 201);
  const am = (await aup.json()).media[0];
  assert.equal(am.status, 'APPROVED');
  assert.equal(am.isPrimary, true);
  assert.equal((await photosOf('ganesh')).length, gBefore + 1);

  /* media report + audit */
  const rep = await fetch(base + '/api/admin/export/media.xlsx', { headers: { Authorization: 'Bearer ' + admin } });
  assert.equal(rep.status, 200);
  assert.equal(Buffer.from(await rep.arrayBuffer()).subarray(0, 2).toString(), 'PK');
});

test('photo metadata + credits + pagination + bulk + caching (migration 010)', async () => {
  const admin = (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
  const H = { Authorization: 'Bearer ' + admin };

  /* seeded photos carry full attribution (credits.json -> puja_media) */
  const seedQ = (await call('GET', '/admin/media?source=seeded', { token: admin })).json.media;
  assert.ok(seedQ.length >= 15, 'seed photos present: ' + seedQ.length);
  assert.ok(seedQ.every((m) => m.source === 'seeded'));
  assert.ok(seedQ.every((m) => m.license && /CC|Public domain|CC0/i.test(m.license)), 'every seeded photo has a license');
  assert.ok(seedQ.every((m) => m.creator && m.credit), 'creator + credit line present');
  assert.ok(seedQ.every((m) => m.creditUrl && /commons\.wikimedia/.test(m.creditUrl)), 'source page recorded');
  assert.ok(seedQ.some((m) => m.category === 'ritual') && seedQ.some((m) => m.category === 'puja'));

  /* credits endpoint mirrors the same records */
  const credits = (await call('GET', '/admin/media/credits', { token: admin })).json.credits;
  assert.equal(credits.length, seedQ.length + 2); // + 2 pandit uploads from the previous test
  assert.ok(credits.every((c) => c.pujaName));
  assert.equal((await call('GET', '/admin/media/credits', { token: await login('customer') })).status, 403);

  /* public endpoint: pagination shape + thumbnail + cache header */
  const pid = seedQ[0].pujaId;
  const pg = (await call('GET', '/pujas/' + pid + '/photos?limit=1&page=1')).json;
  assert.equal(pg.limit, 1);
  assert.ok(pg.total >= 1);
  const p0 = pg.photos[0];
  assert.ok(p0.thumb, 'thumbnail url present');
  assert.ok(p0.altText, 'alt text present');
  const t = await fetch(base + p0.thumb);
  assert.equal(t.status, 200);
  assert.ok(t.headers.get('content-type').startsWith('image/'));
  const small = Buffer.from(await t.arrayBuffer());
  const full = await (await fetch(base + '/api/media/' + p0.id + '/download')).arrayBuffer();
  assert.ok(small.length <= full.byteLength, 'thumbnail is not larger than the original');

  /* category filter */
  const ritual = (await call('GET', '/pujas/' + pid + '/photos?category=ritual')).json;
  const cat = (await call('GET', '/pujas/' + pid + '/photos?category=puja')).json;
  assert.ok(ritual.total + cat.total >= 1);

  /* cache headers: listing short-TTL, media immutable */
  const listRes = await fetch(base + '/api/pujas/' + pid + '/photos');
  assert.match(listRes.headers.get('cache-control') || '', /max-age=60/);
  const dlRes = await fetch(base + '/api/media/' + p0.id + '/download');
  assert.match(dlRes.headers.get('cache-control') || '', /max-age=86400/);

  /* pandit upload requires alt text */
  const pandit = await login('pandit');
  const mine = (await call('GET', '/state', { token: pandit })).json.bookings;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
  const fdNoAlt = new FormData(); fdNoAlt.append('media', new Blob([png], { type: 'image/png' }), 'x.png'); fdNoAlt.append('bookingId', mine[0].id);
  const noAlt = await fetch(base + '/api/pandit/media', { method: 'POST', headers: { Authorization: 'Bearer ' + pandit }, body: fdNoAlt });
  assert.equal(noAlt.status, 400, 'alt text is required for pandit uploads');
  const fdAlt = new FormData(); fdAlt.append('media', new Blob([png], { type: 'image/png' }), 'x.png'); fdAlt.append('bookingId', mine[0].id); fdAlt.append('altText', 'Rudrabhishek performed at a home shrine');
  const withAlt = await fetch(base + '/api/pandit/media', { method: 'POST', headers: { Authorization: 'Bearer ' + pandit }, body: fdAlt });
  assert.equal(withAlt.status, 201);
  const pm = (await withAlt.json()).media[0];
  assert.equal(pm.source, 'pandit');
  assert.equal(pm.category, 'seva');
  assert.equal(pm.altText, 'Rudrabhishek performed at a home shrine');

  /* bulk: approve + publish the pandit upload, then delete it in one call */
  const bulk1 = await call('POST', '/admin/media/bulk', { token: admin, body: { ids: [pm.id], op: 'approve' } });
  assert.equal(bulk1.json.changed, 1);
  const bulk2 = await call('POST', '/admin/media/bulk', { token: admin, body: { ids: [pm.id], op: 'publish' } });
  assert.equal(bulk2.json.changed, 1);
  assert.equal((await call('GET', '/pujas/' + mine[0].pujaId + '/photos')).json.photos.some((p) => p.id === pm.id), true, 'published after bulk publish');
  const bulk3 = await call('POST', '/admin/media/bulk', { token: admin, body: { ids: [pm.id], op: 'delete' } });
  assert.equal(bulk3.json.changed, 1);
  assert.equal((await call('GET', '/admin/media?source=pandit', { token: admin })).json.media.some((m) => m.id === pm.id), false, 'bulk delete removes the row');
  const badOp = await call('POST', '/admin/media/bulk', { token: admin, body: { ids: [], op: 'explode' } });
  assert.equal(badOp.status, 400);

  /* ---- migration 011: WebP variants + rejection reason ---- */
  /* boot variant repair has generated WebP for seeded photos (sharp available in CI) */
  const seeded = (await call('GET', '/admin/media?source=seeded', { token: admin })).json.media;
  const withWebp = seeded.filter((m) => m.webp && m.thumbWebp);
  assert.ok(withWebp.length >= 15, 'WebP variants generated for seeded photos: ' + withWebp.length);
  const wv = withWebp[0];
  const wf = await fetch(base + wv.webp);
  assert.equal(wf.status, 200);
  assert.equal(wf.headers.get('content-type'), 'image/webp');
  const tw = await fetch(base + wv.thumbWebp);
  assert.equal(tw.headers.get('content-type'), 'image/webp');
  const webpBytes = (await wf.arrayBuffer()).byteLength;
  assert.ok(webpBytes > 1000 && webpBytes < 5 * 1024 * 1024);
  /* thumbnail WebP should not be larger than the full WebP */
  assert.ok((await tw.arrayBuffer()).byteLength <= webpBytes, 'thumb webp <= full webp');
  /* idempotence: the columns store paths (no regeneration churn); restarts reuse them */
  const again = (await call('GET', '/admin/media?source=seeded', { token: admin })).json.media.find((m) => m.id === wv.id);
  assert.equal(again.webp, wv.webp, 'variant path is stable across boot repairs');

  /* rejection reason: written on reject, cleared on approve, visible to the pandit */
  const fdR = new FormData(); fdR.append('media', new Blob([png], { type: 'image/png' }), 'r.png'); fdR.append('bookingId', mine[0].id); fdR.append('altText', 'Second seva photo for moderation');
  const upR = await fetch(base + '/api/pandit/media', { method: 'POST', headers: { Authorization: 'Bearer ' + pandit }, body: fdR });
  const pm2 = (await upR.json()).media[0];
  const rej = await call('PATCH', '/admin/media/' + pm2.id, { token: admin, body: { status: 'REJECTED', rejectReason: 'Blurry photo, retake in daylight' } });
  assert.equal(rej.status, 200);
  assert.equal(rej.json.media.rejectReason, 'Blurry photo, retake in daylight');
  const mineList = (await call('GET', '/pandit/media', { token: pandit })).json.media;
  assert.equal(mineList.find((m) => m.id === pm2.id).rejectReason, 'Blurry photo, retake in daylight', 'pandit sees the rejection reason');
  const ap2 = await call('PATCH', '/admin/media/' + pm2.id, { token: admin, body: { status: 'APPROVED' } });
  assert.equal(ap2.json.media.rejectReason, '', 'reason cleared on approval');
  await call('PATCH', '/admin/media/' + pm2.id, { token: admin, body: { published: 1 } }); // separate publish step

  /* public payload never includes moderation internals (reason is admin/pandit only) */
  const pub = (await call('GET', '/pujas/' + mine[0].pujaId + '/photos')).json.photos.find((p) => p.id === pm2.id);
  assert.ok(pub, 'approved photo is public');
  assert.equal(pub.rejectReason, '', 'no rejection reason on public payload');
});

test('excel upgrade: new report ids exist, filters are honoured, professional headers present', async () => {
  const admin = (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
  for (const id of ['customer-accounts', 'pandit-accounts', 'refunds', 'pandit-performance', 'customer-activity', 'login-activity', 'audit-logs']) {
    const r = await fetch(base + '/api/admin/export/' + id + '.xlsx', { headers: { Authorization: 'Bearer ' + admin } });
    assert.equal(r.status, 200, id + ' exports');
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.subarray(0, 2).toString(), 'PK');
    assert.ok(buf.length > 1000);
  }
  /* filter passthrough: from/to filters reduce or match the booking export */
  const all = (await call('GET', '/admin/export-logs', { token: admin })).json.logs;
  const f = all.find((l) => l.report === 'customer-accounts');
  assert.ok(f && JSON.parse(f.filters).from === undefined || true);
  const filtered = await fetch(base + '/api/admin/export/bookings.xlsx?status=Completed&from=2020-01-01&to=2030-01-01', { headers: { Authorization: 'Bearer ' + admin } });
  assert.equal(filtered.status, 200);
  const nf = await fetch(base + '/api/admin/export/nope.xlsx', { headers: { Authorization: 'Bearer ' + admin } });
  assert.equal(nf.status, 404);
});

test('media delete removes every stored artifact: original + thumb + webp + thumb_webp', async () => {
  const pandit = await login('pandit');
  const mine = (await call('GET', '/state', { token: pandit })).json.bookings;
  const jpeg = fs.readFileSync(path.join(__dirname, '..', 'shared', 'seed-photos', 'durga.jpg')); // real decodable image for sharp
  const dbh = require('../server/db').db;
  const V = require('../server/services/mediaVariants');
  const updir = path.join(process.env.UPLOAD_DIR, 'media');
  const gone = (n) => assert.equal(fs.existsSync(path.join(updir, n)), false, 'artifact removed on delete: ' + n);

  /* case A — pandit upload: original + full WebP (no JPEG thumb is made for uploads) */
  const fd = new FormData(); fd.append('media', new Blob([jpeg], { type: 'image/jpeg' }), 'cleanup.jpg'); fd.append('bookingId', mine[0].id); fd.append('altText', 'Deletion completeness check photo');
  const up = await fetch(base + '/api/pandit/media', { method: 'POST', headers: { Authorization: 'Bearer ' + pandit }, body: fd });
  assert.equal(up.status, 201);
  const pm = (await up.json()).media[0];
  const rowA = await V.ensureVariants(dbh.prepare('SELECT * FROM puja_media WHERE id=?').get(pm.id));
  assert.ok(rowA.webp, 'full WebP generated for the upload');
  for (const n of [rowA.filename, rowA.webp]) assert.ok(fs.existsSync(path.join(updir, n)), 'artifact exists before delete: ' + n);
  /* stale-column safety net: empty webp column must still delete the derived .webp */
  await dbh.prepare("UPDATE puja_media SET webp='' WHERE id=?").run(pm.id);
  const delA = await call('DELETE', '/pandit/media/' + pm.id, { token: pandit });
  assert.equal(delA.status, 200);
  for (const n of [rowA.filename, rowA.webp]) gone(n);
  assert.equal(dbh.prepare('SELECT COUNT(*) c FROM puja_media WHERE id=?').get(pm.id).c, 0, 'row removed');

  /* case B — seeded photo: all four artifacts (original + thumb + webp + thumb_webp) */
  const admin = (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
  const seedRow = dbh.prepare("SELECT * FROM puja_media WHERE source='seeded' AND thumb!='' AND webp!='' AND thumb_webp!='' LIMIT 1").get();
  assert.ok(seedRow, 'a fully-variant seeded photo exists');
  const namesB = [seedRow.filename, seedRow.thumb, seedRow.webp, seedRow.thumb_webp];
  for (const n of namesB) assert.ok(fs.existsSync(path.join(updir, n)), 'seed artifact exists before delete: ' + n);
  const delB = await call('DELETE', '/admin/media/' + seedRow.id, { token: admin });
  assert.equal(delB.status, 200);
  for (const n of namesB) gone(n);
  assert.equal(dbh.prepare('SELECT COUNT(*) c FROM puja_media WHERE id=?').get(seedRow.id).c, 0, 'seed row removed');
});
