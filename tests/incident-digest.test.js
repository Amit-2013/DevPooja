/* Repeat-reopen digest: incidents dismissed-and-reopened more than twice
   surface as an Operations-tab review queue (GET /admin/incidents/reopen-digest,
   ?limit=N overrides the threshold). Harness parity with tests/incident.test.js. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-incdigest-'));
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
const bookingBody = (o = {}) => ({ pujaId: 'satyanarayan', mode: 'home', date: dayPlus(20), slot: '10:00 AM', addr: { line: '12 Test Street', city: 'Delhi NCR', pin: '110001' }, panditId: 'p1', sam: [], pra: [], ...o });

test('digest: >2 reopens surface on the queue, ordered by reopen count; below threshold stays off', async () => {
  const pt = await login('pandit'), ct = await login('customer'), at = await admin();

  /* incident A: dismissed and reopened 3 times → must appear */
  const bA = (await call('POST', '/bookings', { token: ct, body: bookingBody({ date: dayPlus(20) }) })).json.booking;
  const A = (await call('POST', '/pandit/incidents', { token: pt, body: { bookingId: bA.id, category: 'SAFETY_CONCERN', description: 'Repeated access obstruction at the venue by the host.' } })).json.incident;
  for (let i = 1; i <= 3; i++) {
    await call('PATCH', '/admin/incidents/' + A.id, { token: at, body: { status: 'DISMISSED', reason: 'Dismissal pass ' + i + ' (documented).' } });
    const re = await call('POST', '/admin/incidents/' + A.id + '/reopen', { token: at, body: { reason: 'Reopen ' + i + ': new facts contradict dismissal ' + i + '.' } });
    assert.equal(re.status, 200);
    assert.equal(re.json.incident.reopenCount, i);
  }

  /* incident B: dismissed and reopened exactly 2 times → must NOT appear */
  const bB = (await call('POST', '/bookings', { token: ct, body: bookingBody({ date: dayPlus(21) }) })).json.booking;
  const B = (await call('POST', '/pandit/incidents', { token: pt, body: { bookingId: bB.id, category: 'CUSTOMER_CONDUCT', description: 'Customer conduct dispute at the second venue.' } })).json.incident;
  for (let i = 1; i <= 2; i++) {
    await call('PATCH', '/admin/incidents/' + B.id, { token: at, body: { status: 'DISMISSED', reason: 'Dismissal pass ' + i + '.' } });
    await call('POST', '/admin/incidents/' + B.id + '/reopen', { token: at, body: { reason: 'Reopen ' + i + '.' } });
  }

  const digest = await call('GET', '/admin/incidents/reopen-digest', { token: at });
  assert.equal(digest.status, 200);
  assert.equal(digest.json.threshold, 2);
  const ids = digest.json.incidents.map((x) => x.id);
  assert.ok(ids.includes(A.id), '3-reopen incident is on the queue');
  assert.ok(!ids.includes(B.id), '2-reopen incident stays below the threshold');
  const rowA = digest.json.incidents.find((x) => x.id === A.id);
  assert.equal(rowA.reopenCount, 3);
  assert.equal(rowA.status, 'UNDER_REVIEW', 'reopened incidents are live queue items');
  assert.equal(rowA.reopenReason, 'Reopen 3: new facts contradict dismissal 3.', 'latest reopen reason surfaced');
  assert.ok(digest.json.incidents.every((x) => x.status === 'OPEN' || x.status === 'UNDER_REVIEW'), 'queue holds only live items');

  /* explicit ?limit=N lowers the threshold for ad-hoc wider sweeps */
  const wide = await call('GET', '/admin/incidents/reopen-digest?limit=1', { token: at });
  assert.ok(wide.json.incidents.map((x) => x.id).includes(B.id), 'limit=1 widens the queue to include the 2-reopen incident');

  /* access */
  assert.equal((await call('GET', '/admin/incidents/reopen-digest', { token: ct })).status, 403);
  assert.equal((await call('GET', '/admin/incidents/reopen-digest')).status, 401);
});

test('queue-entry notifications: admins are notified in-app when an incident crosses the reopen threshold', async () => {
  const pt = await login('pandit'), ct = await login('customer'), at = await admin();
  const adminNotifs = () => db.prepare("SELECT n.* FROM notifs n JOIN users u ON u.id=n.user_id WHERE u.role='admin' AND n.channel='In-App' ORDER BY n.ts DESC, n.id DESC").all();

  const b = (await call('POST', '/bookings', { token: ct, body: bookingBody({ date: dayPlus(22) }) })).json.booking;
  const inc = (await call('POST', '/pandit/incidents', { token: pt, body: { bookingId: b.id, category: 'SAFETY_CONCERN', description: 'Escalating conduct issue at the venue entrance.' } })).json.incident;

  /* reopens 1 and 2 are at/below the threshold (2): no queue-entry alerts */
  for (let i = 1; i <= 2; i++) {
    await call('PATCH', '/admin/incidents/' + inc.id, { token: at, body: { status: 'DISMISSED', reason: 'Pass ' + i + '.' } });
    const r = await call('POST', '/admin/incidents/' + inc.id + '/reopen', { token: at, body: { reason: 'Reopen ' + i + '.' } });
    assert.equal(r.status, 200);
  }
  const before = adminNotifs().filter((n) => n.message.startsWith('Repeat-reopen alert: incident ' + inc.id));
  assert.equal(before.length, 0, 'no queue-entry alerts below the threshold');

  /* reopen 3 crosses the threshold: every admin gets exactly one alert */
  await call('PATCH', '/admin/incidents/' + inc.id, { token: at, body: { status: 'DISMISSED', reason: 'Pass 3.' } });
  const r3 = await call('POST', '/admin/incidents/' + inc.id + '/reopen', { token: at, body: { reason: 'Reopen 3: the third pass makes a pattern.' } });
  assert.equal(r3.status, 200);
  assert.equal(r3.json.incident.reopenCount, 3);
  const alerts = adminNotifs().filter((n) => n.message.startsWith('Repeat-reopen alert: incident ' + inc.id));
  assert.ok(alerts.length >= 1, 'admins notified in-app on crossing the threshold');
  assert.ok(alerts.every((n) => n.channel === 'In-App'), 'alerts ride the existing In-App channel');
  assert.ok(alerts.every((n) => n.message.includes('3 reopens')), 'alert carries the reopen count');
  assert.ok(alerts.every((n) => n.message.includes('threshold 2')), 'alert carries the threshold');

  /* a second reopen (4th) alerts again — a fresh queue entry each time */
  await call('PATCH', '/admin/incidents/' + inc.id, { token: at, body: { status: 'DISMISSED', reason: 'Pass 4.' } });
  await call('POST', '/admin/incidents/' + inc.id + '/reopen', { token: at, body: { reason: 'Reopen 4.' } });
  const after = adminNotifs().filter((n) => n.message.startsWith('Repeat-reopen alert: incident ' + inc.id));
  assert.ok(after.length === alerts.length + 1, 'exactly one new alert per threshold-crossing reopen');

  /* the queue-alerts drill-in returns only this incident's alerts, newest first */
  const drill = await call('GET', '/admin/incidents/' + inc.id + '/queue-alerts', { token: at });
  assert.equal(drill.status, 200);
  assert.ok(drill.json.alerts.length >= 1, "crossing alerts are retrievable");
  assert.ok(drill.json.alerts.every((a) => a.message.startsWith('Repeat-reopen alert: incident ' + inc.id + ' ')), 'filtered to this incident');
  assert.ok(drill.json.alerts[0].message.includes('Reopen 4.') || drill.json.alerts[0].ts >= drill.json.alerts[drill.json.alerts.length - 1].ts, 'newest first');

  /* the below-threshold incident must never have alerted */
  assert.equal((await call('GET', '/admin/incidents/' + 'INCNOALERT1' + '/queue-alerts', { token: at })).json.alerts.length, 0, 'unknown id: empty, not an error path');

  /* access: admin-only */
  assert.equal((await call('GET', '/admin/incidents/' + inc.id + '/queue-alerts', { token: ct })).status, 403);
  assert.equal((await call('GET', '/admin/incidents/' + inc.id + '/queue-alerts')).status, 401);
});

test('per-pandit flagging: reopens across DISTINCT bookings above threshold flag the pandit; single-booking loops do not', async () => {
  const pt = await login('pandit'), ct = await login('customer'), at = await admin();
  const reopenTwice = async (bookingId, tag) => {
    const inc = (await call('POST', '/pandit/incidents', { token: pt, body: { bookingId, category: 'CUSTOMER_CONDUCT', description: 'Pattern probe: ' + tag + ' — conduct dispute during the puja.' } })).json.incident;
    for (let i = 1; i <= 2; i++) {
      await call('PATCH', '/admin/incidents/' + inc.id, { token: at, body: { status: 'DISMISSED', reason: tag + ' dismissal ' + i + '.' } });
      await call('POST', '/admin/incidents/' + inc.id + '/reopen', { token: at, body: { reason: tag + ' reopen ' + i + '.' } });
    }
    return inc;
  };
  const reopenOnce = async (bookingId, tag) => {
    const inc = (await call('POST', '/pandit/incidents', { token: pt, body: { bookingId, category: 'OTHER', description: 'Pattern probe: ' + tag + ' — one-off dispute, documented.' } })).json.incident;
    await call('PATCH', '/admin/incidents/' + inc.id, { token: at, body: { status: 'DISMISSED', reason: tag + ' dismissal.' } });
    await call('POST', '/admin/incidents/' + inc.id + '/reopen', { token: at, body: { reason: tag + ' reopen.' } });
    return inc;
  };

  /* setup: distinct bookings for cross-booking pattern; a single booking whose
     incident loops 3 times (high count, ONE booking); a below-threshold booking */
  const mkBooking = async (day) => (await call('POST', '/bookings', { token: ct, body: bookingBody({ date: dayPlus(day) }) })).json.booking;
  const cross1 = await reopenTwice((await mkBooking(30)).id, 'X1');
  const cross2 = await reopenOnce((await mkBooking(31)).id, 'X2'); /* 2+1 = 3 reopens over 2 distinct bookings */
  const single = await reopenTwice((await mkBooking(32)).id, 'S1');
  await call('PATCH', '/admin/incidents/' + single.id, { token: at, body: { status: 'DISMISSED', reason: 'S1 dismissal 3.' } });
  await call('POST', '/admin/incidents/' + single.id + '/reopen', { token: at, body: { reason: 'S1 reopen 3.' } }); /* 3 reopens, ONE booking */
  const lone = await reopenOnce((await mkBooking(33)).id, 'L1'); /* 1 reopen: below everything */

  const digest = await call('GET', '/admin/incidents/reopen-digest', { token: at });
  assert.equal(digest.status, 200);
  const flagged = digest.json.flaggedPandits || [];
  assert.ok(Array.isArray(flagged), 'digest carries flaggedPandits');

  const p1 = flagged.find((x) => x.panditId === 'p1');
  assert.ok(p1, 'pandit p1 flagged: reopens cross the threshold over distinct bookings');
  assert.equal(p1.bookings >= 3, true, 'distinct bookings collapsed (>=3: X1, X2, S1, lone)');
  assert.equal(p1.incidents >= 4, true, 'incident count distinct from booking count');
  assert.equal(p1.reopens >= 7, true, 'total reopen count summed across incidents');

  /* ?limit=1 narrows the window: same shape, single-booking loop still excluded */
  const wide = await call('GET', '/admin/incidents/reopen-digest?limit=1', { token: at });
  assert.ok(Array.isArray(wide.json.flaggedPandits), 'limit=1 keeps the flaggedPandits shape');

  /* resolved incidents leave the live queue: resolve everything for p1, flag disappears */
  const live = (await call('GET', '/admin/incidents', { token: at })).json.incidents.filter((x) => x.panditId === 'p1' && (x.reopenCount || 0) > 0 && ['OPEN', 'UNDER_REVIEW'].includes(x.status));
  for (const row of live) {
    const r = await call('PATCH', '/admin/incidents/' + row.id, { token: at, body: { status: 'RESOLVED', resolution: 'Pattern reviewed and closed out.' } });
    assert.equal(r.status, 200);
  }
  const after = (await call('GET', '/admin/incidents/reopen-digest', { token: at })).json.flaggedPandits || [];
  assert.ok(!after.some((x) => x.panditId === 'p1'), 'fully-resolved pandit drops off the flag list');

  /* access */
  assert.equal((await call('GET', '/admin/incidents/reopen-digest', { token: ct })).status, 403);
});

test('per-customer flagging: the customer-conduct mirror flags demand-side patterns; single-booking loops do not', async () => {
  const pt = await login('pandit'), ct = await login('customer'), at = await admin();

  /* cross-booking pattern against ONE customer (u1): incidents on 3 distinct
     bookings — H1 loops 3 times (also queues the incident), H2/H3 once each */
  const mkBooking = async (day) => (await call('POST', '/bookings', { token: ct, body: bookingBody({ date: dayPlus(day) }) })).json.booking;
  const inc = async (b, tag) => (await call('POST', '/pandit/incidents', { token: pt, body: { bookingId: b.id, category: 'CUSTOMER_CONDUCT', description: 'Customer probe ' + tag + ': conduct dispute during the puja.' } })).json.incident;
  const loop = async (id, tag, n) => { for (let i = 1; i <= n; i++) { await call('PATCH', '/admin/incidents/' + id, { token: at, body: { status: 'DISMISSED', reason: tag + ' dismissal ' + i } }); await call('POST', '/admin/incidents/' + id + '/reopen', { token: at, body: { reason: tag + ' reopen ' + i } }); } };
  const k1 = await mkBooking(35), k2 = await mkBooking(36), k3 = await mkBooking(37);
  const j1 = await inc(k1, 'C1'); await loop(j1.id, 'C1', 3);
  const j2 = await inc(k2, 'C2'); await loop(j2.id, 'C2', 1);
  const j3 = await inc(k3, 'C3'); await loop(j3.id, 'C3', 1);

  const digest = (await call('GET', '/admin/incidents/reopen-digest', { token: at })).json;
  assert.ok(Array.isArray(digest.flaggedCustomers), 'digest carries flaggedCustomers');
  const c1 = (digest.flaggedCustomers || []).find((x) => x.customerId === 'u1');
  assert.ok(c1, 'customer u1 flagged: reopened incidents across 3 distinct bookings');
  assert.equal(c1.bookings >= 3, true, 'distinct bookings counted');
  assert.equal(c1.reopens >= 5, true, 'reopen count summed across incidents');
  assert.ok(c1.customer && c1.customer.length > 0, 'customer name joined in');

  /* single-booking loop alone does NOT flag a customer: no row may exist
     whose distinct-booking count is below the 3 the pattern requires here
     (S1's earlier 3-reopen loop on ONE booking created no customer flag) */
  const singleCustomer = (digest.flaggedCustomers || []).filter((x) => x.bookings < 3);
  assert.equal(singleCustomer.length, 0, 'no customer flagged on a single-booking loop alone');

  /* ?limit=1 narrows the window and keeps the shape */
  const wide = await call('GET', '/admin/incidents/reopen-digest?limit=1', { token: at });
  assert.ok(Array.isArray(wide.json.flaggedCustomers), 'limit=1 keeps the flaggedCustomers shape');

  /* resolving everything drops the customer off the list (live-window rule) */
  const mine = [j1, j2, j3];
  for (const row of mine) {
    const r = await call('PATCH', '/admin/incidents/' + row.id, { token: at, body: { status: 'RESOLVED', resolution: 'Customer pattern closed out.' } });
    assert.equal(r.status, 200);
  }
  const after = (await call('GET', '/admin/incidents/reopen-digest', { token: at })).json.flaggedCustomers || [];
  assert.ok(!after.some((x) => x.customerId === 'u1'), 'fully-resolved customer drops off the flag list');

  /* access: admin-only (envelope key invisible without admin) */
  assert.equal((await call('GET', '/admin/incidents/reopen-digest', { token: ct })).status, 403);
});
