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
