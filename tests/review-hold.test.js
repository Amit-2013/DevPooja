/* Review hold for flagged-pandit bookings — twin of backend-python/tests/test_review_hold.py.
   While a pandit is flagged by the repeat-reopen digest (live incidents reopened
   across DISTINCT bookings beyond REOPEN_LIMIT), their NEW bookings are stamped
   with a review hold: the pandit cannot accept or start them until an admin
   releases the booking or every live incident is resolved (auto-release). */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-hold-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../server/db');
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
const dayPlus = (n) => { const d = new Date(); d.setHours(12); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const bookingBody = (o = {}) => ({ pujaId: 'satyanarayan', mode: 'home', date: dayPlus(21), slot: '10:00 AM', addr: { line: '12 Test Street', city: 'Delhi NCR', pin: '110001' }, panditId: 'p1', sam: [], pra: [], ...o });
const dismissReopen = async (at, id, tag, n) => {
  for (let i = 1; i <= n; i++) {
    await call('PATCH', '/admin/incidents/' + id, { token: at, body: { status: 'DISMISSED', reason: tag + ' dismissal ' + i } });
    await call('POST', '/admin/incidents/' + id + '/reopen', { token: at, body: { reason: tag + ' reopen ' + i } });
  }
};

test('review hold: flagged pandit booking holds, guard fires, release and auto-release free it', async () => {
  const pt = await login('pandit'), ct = await login('customer'), at = await admin();

  /* Build the cross-booking pattern: incidents on 3 distinct live bookings.
     B1 gets reopened 3 times (joins the digest queue), B2/B3 once each —
     the DISTINCT-bookings count crosses the threshold (>2) only via all three. */
  const mkBooking = async (day) => (await call('POST', '/bookings', { token: ct, body: bookingBody({ date: dayPlus(day) }) })).json.booking;
  const b1 = await mkBooking(25), b2 = await mkBooking(26), b3 = await mkBooking(27);
  const i1 = (await call('POST', '/pandit/incidents', { token: pt, body: { bookingId: b1.id, category: 'CUSTOMER_CONDUCT', description: 'Hold probe X1: conduct dispute during the puja.' } })).json.incident;
  const i2 = (await call('POST', '/pandit/incidents', { token: pt, body: { bookingId: b2.id, category: 'OTHER', description: 'Hold probe X2: one-off dispute, documented.' } })).json.incident;
  const i3 = (await call('POST', '/pandit/incidents', { token: pt, body: { bookingId: b3.id, category: 'OTHER', description: 'Hold probe X3: another one-off dispute.' } })).json.incident;
  await dismissReopen(at, i1.id, 'X1', 3);
  await dismissReopen(at, i2.id, 'X2', 1);
  await dismissReopen(at, i3.id, 'X3', 1);
  const digest = (await call('GET', '/admin/incidents/reopen-digest', { token: at })).json;
  assert.ok(digest.flaggedPandits.some((x) => x.panditId === 'p1'), 'p1 is flagged now');

  /* admin creates a manual booking and assigns it to the flagged pandit */
  const mk = await call('POST', '/admin/bookings/manual', { token: at, body: { name: 'Hold Probe', mobile: '9876511001', pujaId: 'lakshmi', mode: 'home', slot: '10:00 AM', date: dayPlus(30) } });
  assert.equal(mk.status, 201, 'manual booking created');
  const bk = mk.json.booking;
  const asg = await call('POST', '/admin/bookings/' + bk.id + '/assign', { token: at, body: { panditId: 'p1' } });
  assert.equal(asg.status, 200);
  const stamped = (await call('GET', '/state', { token: at })).json.bookings.find((x) => x.id === bk.id);
  assert.equal(stamped.reviewHold, true, 'assigned booking is stamped with the review hold');
  assert.ok(stamped.holdReason.includes('flagged'), 'hold reason explains the flag');

  /* the customer-created booking to the flagged pandit also holds (created while flagged) */
  const b4 = await mkBooking(28);
  assert.equal(b4.reviewHold, true, 'customer booking to flagged pandit holds');

  /* guard: pandit cannot accept the held booking */
  const refuse = await call('POST', '/pandit/bookings/' + b4.id + '/accept', { token: pt, body: {} });
  assert.equal(refuse.status, 409);
  assert.ok(refuse.json.error.includes('review hold'), 'the refusal explains the hold');

  /* non-held bookings keep working */
  const okBooking = (await call('GET', '/state', { token: at })).json.bookings.find((x) => x.id === b2.id);
  assert.equal(okBooking.reviewHold, false, 'pre-flag booking was not stamped');

  /* admin release: frees the booking and notifies the pandit */
  const rel = await call('POST', '/admin/bookings/' + b4.id + '/release-hold', { token: at, body: {} });
  assert.equal(rel.json.released, true);
  assert.equal(rel.json.booking.reviewHold, false);
  const releasedOk = await call('POST', '/pandit/bookings/' + b4.id + '/accept', { token: pt, body: {} });
  assert.equal(releasedOk.status, 200, 'pandit can accept after release');
  const again = await call('POST', '/admin/bookings/' + b4.id + '/release-hold', { token: at, body: {} });
  assert.equal(again.json.released, false, 'releasing a clean booking is a no-op');

  /* auto-release: resolving every live incident clears the flag and the sweep frees the rest */
  const live = (await call('GET', '/admin/incidents', { token: at })).json.incidents
    .filter((x) => x.panditId === 'p1' && (x.reopenCount || 0) > 0 && ['OPEN', 'UNDER_REVIEW'].includes(x.status));
  for (const row of live) await call('PATCH', '/admin/incidents/' + row.id, { token: at, body: { status: 'RESOLVED', resolution: 'Hold probe closed.' } });
  const after = (await call('GET', '/admin/incidents/reopen-digest', { token: at })).json;
  assert.ok(!after.flaggedPandits.some((x) => x.panditId === 'p1'), 'flag cleared after resolving');
  const remaining = (await call('GET', '/state', { token: at })).json.bookings.filter((x) => x.panditId === 'p1' && x.reviewHold);
  assert.equal(remaining.length, 0, 'all held bookings auto-released');

  /* access: admin-only release */
  assert.equal((await call('POST', '/admin/bookings/' + b1.id + '/release-hold', { token: ct })).status, 403);
});
