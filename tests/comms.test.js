/* Phases 27-29 — Communication engine: twin of backend-python/tests/test_comms.py.
   Covers: the campaign lifecycle state machine (DRAFT → SCHEDULED → SENDING →
   SENT | FAILED, CANCELLED only from not-yet-sent), the only-DRAFT edit guard,
   consent-skips with delivery rows, audience resolution, the due-campaign sweep,
   /push through the engine, and the stateless Excel import (preview → commit →
   re-preview dedupe) with bad-file rejection and access control. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-comms-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const test = require('node:test');
const assert = require('node:assert/strict');
const seedMod = require('../server/seed');
const app = require('../server/index.js');
const { db } = require('../server/db');

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
/* Multipart variant for the xlsx import routes. */
async function callForm(url, token, buf, name = 't.xlsx') {
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(buf)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
  const r = await fetch(base + '/api' + url, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const admin = async () => (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
const login = async (role) => (await call('POST', '/auth/demo', { body: { role } })).json.token;
const mkCustomer = (id, name, mobile, email, pref) => db.prepare(`INSERT INTO users(id,role,name,mobile,email,pts,plus,pref,addr,fam,joined,created_at) VALUES(?,'customer',?,?,?,?,0,?,'[]','[]',?,?)`)
  .run(id, name, mobile, email, 0, JSON.stringify(pref), new Date().toISOString().slice(0, 10), Date.now());
const deliveries = (cid) => db.prepare('SELECT user_id, status, detail FROM notification_deliveries WHERE campaign_id=?').all(cid);

test('campaign lifecycle: draft → scheduled → sent with guards on the way back', async () => {
  const at = await admin();
  /* Create: starts as DRAFT. */
  let r = await call('POST', '/admin/campaigns', { token: at, body: { name: 'Diwali blast', channel: 'In-App', audience: 'All customers', message: 'Happy Diwali!' } });
  assert.equal(r.status, 201); const c = r.json.campaign;
  assert.equal(c.status, 'DRAFT');

  /* Edit while DRAFT works. */
  r = await call('PATCH', '/admin/campaigns/' + c.id, { token: at, body: { message: 'Diwali 20% off' } });
  assert.equal(r.status, 200); assert.equal(r.json.campaign.message, 'Diwali 20% off');

  /* Schedule (future) → SCHEDULED; the engine locks editing. */
  r = await call('POST', '/admin/campaigns/' + c.id + '/schedule', { token: at, body: { scheduledAt: Date.now() + 3600000 } });
  assert.equal(r.status, 200); assert.equal(r.json.campaign.status, 'SCHEDULED');
  assert.equal((await call('PATCH', '/admin/campaigns/' + c.id, { token: at, body: { name: 'nope' } })).status, 409, 'edit after schedule blocked');
  assert.equal((await call('POST', '/admin/campaigns/' + c.id + '/schedule', { token: at, body: {} })).status, 409, 'double schedule blocked');
  /* Validation on a fresh DRAFT: junk scheduledAt is a 400, not a state conflict. */
  const dj = (await call('POST', '/admin/campaigns', { token: at, body: { name: 'Validation probe', channel: 'Push', audience: 'All customers', message: 'x' } })).json.campaign;
  assert.equal((await call('POST', '/admin/campaigns/' + dj.id + '/schedule', { token: at, body: { scheduledAt: 'soon' } })).status, 400, 'junk scheduledAt rejected');

  /* Early manual send is allowed and finishes the lifecycle. */
  r = await call('POST', '/admin/campaigns/' + c.id + '/send', { token: at, body: {} });
  assert.equal(r.status, 200); assert.equal(r.json.campaign.status, 'SENT');
  assert.ok(r.json.campaign.sent >= 1, 'customers received it');
  assert.ok(r.json.campaign.delivered + r.json.campaign.skipped + r.json.campaign.failed >= 1, 'tallies ride the campaign object');
  assert.equal((await call('POST', '/admin/campaigns/' + c.id + '/send', { token: at, body: {} })).status, 409, 're-send blocked');
  assert.equal((await call('POST', '/admin/campaigns/' + c.id + '/cancel', { token: at, body: {} })).status, 409, 'cancel after send blocked');
  assert.equal((await call('PATCH', '/admin/campaigns/' + c.id, { token: at, body: { name: 'nope' } })).status, 409, 'edit after send blocked');

  /* Detail aggregates the delivery records. */
  r = await call('GET', '/admin/campaigns/' + c.id, { token: at });
  assert.equal(r.status, 200);
  assert.equal(r.json.deliveries.SENT, r.json.campaign.sent);
  assert.ok(Array.isArray(r.json.rows) && r.json.rows.length >= 1);
});

test('consent and contact targets: SKIPPED rows carry the reason, not silence', async () => {
  mkCustomer('xc1', 'Wa Optout', '9700000001', 'xc1@t.in', { wa: false });
  mkCustomer('xc2', 'No Mobile', null, 'xc2@t.in', {});
  const at = await admin();
  const r = await call('POST', '/admin/campaigns', { token: at, body: { name: 'Wa blast', channel: 'WhatsApp', audience: 'All customers', message: 'Namaste' } });
  assert.equal(r.status, 201);
  const s = await call('POST', '/admin/campaigns/' + r.json.campaign.id + '/send', { token: at, body: {} });
  assert.equal(s.status, 200);
  const rows = deliveries(r.json.campaign.id).filter((x) => ['xc1', 'xc2'].includes(x.user_id));
  assert.equal(rows.length, 2, 'opt-out and no-target customers still get delivery rows');
  assert.ok(rows.some((x) => x.status === 'SKIPPED' && /opted out/.test(x.detail)), 'consent skip recorded');
  assert.ok(rows.some((x) => x.status === 'SKIPPED' && /no .*target/.test(x.detail)), 'no-target skip recorded');
});

test('audiences: Plus members resolves to plus=1 customers only', async () => {
  mkCustomer('xp1', 'Plus One', '9700000011', 'xp1@t.in', {});
  db.prepare('UPDATE users SET plus=1 WHERE id=?').run('xp1');
  const at = await admin();
  const r = await call('POST', '/admin/campaigns', { token: at, body: { name: 'Plus perks', channel: 'In-App', audience: 'Plus members', message: 'Perks inside' } });
  const s = await call('POST', '/admin/campaigns/' + r.json.campaign.id + '/send', { token: at, body: {} });
  assert.equal(s.status, 200);
  const rows = deliveries(r.json.campaign.id);
  assert.ok(rows.length >= 1, 'plus customers targeted');
  for (const x of rows) assert.equal(db.prepare('SELECT plus FROM users WHERE id=?').get(x.user_id).plus, 1, 'only plus members targeted');
});

test('cancel while scheduled, and the due-sweep fires past-due campaigns', async () => {
  const at = await admin();
  /* Cancelled never sends — not from the manual sweep, not from the timer. */
  let r = await call('POST', '/admin/campaigns', { token: at, body: { name: 'Later', channel: 'In-App', audience: 'All customers', message: 'Coming soon' } });
  const cid = r.json.campaign.id;
  await call('POST', '/admin/campaigns/' + cid + '/schedule', { token: at, body: { scheduledAt: Date.now() + 86400000 } });
  assert.equal((await call('POST', '/admin/campaigns/' + cid + '/cancel', { token: at, body: {} })).json.campaign.status, 'CANCELLED');
  assert.equal((await call('POST', '/admin/campaigns/due-sweep', { token: at, body: {} })).json.sent, 0, 'cancelled never sends');

  /* Past-due (server was down past its scheduled_at) fires on the sweep. */
  r = await call('POST', '/admin/campaigns', { token: at, body: { name: 'Down then due', channel: 'In-App', audience: 'Plus members', message: 'Sweep fired me' } });
  const cid2 = r.json.campaign.id;
  await call('POST', '/admin/campaigns/' + cid2 + '/schedule', { token: at, body: { scheduledAt: Date.now() + 60000 } });
  db.prepare('UPDATE campaigns SET scheduled_at=? WHERE id=?').run(Date.now() - 60000, cid2); /* backdate: became due while down */
  const swept = await call('POST', '/admin/campaigns/due-sweep', { token: at, body: {} });
  assert.ok(swept.json.sent >= 1, 'due sweep sent the past-due campaign');
  assert.equal((await call('GET', '/admin/campaigns/' + cid2, { token: at })).json.campaign.status, 'SENT');
});

test('legacy /push goes through the engine and leaves delivery records', async () => {
  const at = await admin();
  const before = db.prepare('SELECT COUNT(*) n FROM notification_deliveries').get().n;
  const r = await call('POST', '/admin/push', { token: at, body: { message: 'Temple timings changed' } });
  assert.equal(r.status, 200);
  assert.ok(r.json.sent >= 1);
  const after = db.prepare('SELECT COUNT(*) n FROM notification_deliveries').get().n;
  assert.ok(after > before, 'push deliveries are recorded');
});

test('excel import: preview → commit → re-preview dedupes statelessly', async () => {
  const at = await admin();
  mkCustomer('xi9', 'Pre Existing', '9700000099', 'xi9@t.in', {});
  /* Build a real workbook in memory (exceljs is already a dependency). */
  const Excel = require('exceljs');
  const wb = new Excel.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['name', 'mobile', 'email', 'source', 'details']);
  ws.addRow(['New Import', '9700000010', 'ni@t.in', 'Partner', 'met at expo']);
  ws.addRow(['Dup Name', '9700000010', '', '', '']);
  ws.addRow(['Pre Existing Renamed', '9700000099', '', '', '']);
  ws.addRow(['Bad Mobile', '12345', '', '', '']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());

  let r = await callForm('/admin/import/customers/preview', at, buf);
  assert.equal(r.status, 200);
  const pv = r.json;
  assert.equal(pv.total, 4);
  assert.equal(pv.duplicatesInFile, 1, 'in-file duplicate detected');
  assert.equal(pv.errors.length, 2, 'duplicate + invalid mobile reported');
  assert.equal(pv.willCreate, 1);
  assert.equal(pv.willUpdate, 1, 'existing mobile flagged as update');
  assert.ok(pv.preview.every((p) => ['create', 'update'].includes(p.action)));

  /* Preview is stateless: nothing written yet. */
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE mobile=?').get('9700000010').n, 0);

  /* Commit applies exactly what the preview showed. */
  r = await callForm('/admin/import/customers/commit', at, buf);
  assert.equal(r.status, 200);
  assert.equal(r.json.committed, 2);
  const fresh = db.prepare('SELECT id, name FROM users WHERE mobile=?').get('9700000010');
  assert.ok(fresh, 'new customer created');
  assert.equal(db.prepare('SELECT name FROM users WHERE id=?').get('xi9').name, 'Pre Existing Renamed', 'existing customer renamed');

  /* Re-import the same file: everything is now an update, nothing duplicates. */
  r = await callForm('/admin/import/customers/preview', at, buf);
  assert.equal(r.json.willCreate, 0, 'nothing left to create');
  assert.equal(r.json.existing, 2, 'both rows detected as existing');

  /* Garbage file and unknown kind are rejected. */
  assert.equal((await callForm('/admin/import/customers/preview', at, Buffer.from('not a zip'))).status, 400);
  assert.equal((await callForm('/admin/import/nope/preview', at, buf)).status, 400);

  /* Leads import rides the same engine and lands in the CRM pipeline. */
  const wb2 = new Excel.Workbook();
  const ws2 = wb2.addWorksheet('L');
  ws2.addRow(['name', 'mobile', 'source', 'details']);
  ws2.addRow(['Lead One', '9700000020', 'Partner', 'met at expo']);
  const buf2 = Buffer.from(await wb2.xlsx.writeBuffer());
  r = await callForm('/admin/import/leads/commit', at, buf2);
  assert.equal(r.status, 200);
  assert.equal(r.json.committed, 1);
  assert.ok(db.prepare('SELECT id FROM leads WHERE mobile=?').get('9700000020'), 'lead captured');
});

test('access: campaigns and imports stay admin-only', async () => {
  const ct = await login('customer');
  assert.equal((await call('GET', '/admin/campaigns', { token: ct })).status, 403);
  assert.equal((await call('POST', '/admin/campaigns', { token: ct, body: { name: 'x', channel: 'Push', audience: 'All customers' } })).status, 403);
  assert.equal((await call('GET', '/admin/campaigns')).status, 401);
});
