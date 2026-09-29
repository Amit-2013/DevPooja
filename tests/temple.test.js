/* Phase 12: temple management — admin CRUD over the catalog temples, active
   flag gating the customer directory AND temple-mode bookings, delete-vs-
   deactivate, audits, access control. Harness parity with tests/incident.test.js. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-temple-'));
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
const admin = async () => (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
const dayPlus = (n) => { const d = new Date(); d.setHours(12); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const bookingBody = (o = {}) => ({ pujaId: 'rudra', mode: 'temple', date: dayPlus(21), slot: '08:00 AM', templeId: 't1', panditId: 'p8', sam: [], pra: [], ...o });
const { db } = require('../server/db');

test('temple CRUD: create, edit, list, audit trail', async () => {
  const at = await admin();
  const before = (await call('GET', '/admin/temples', { token: at })).json.temples;
  assert.ok(before.length >= 6, 'seeded temples listed');

  const created = await call('POST', '/admin/temples', { token: at, body: { name: 'Kashi Vishwanath Annex', city: 'Varanasi', deity: 'Shiva', timings: '5:30 AM - 11:00 AM', descr: 'Annex hall for special bookings.', pujas: ['rudra', 'mrityunjaya'] } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const t = created.json.temple;
  assert.ok(t.id);
  assert.equal(t.active, 1);
  assert.deepEqual(t.pujas, ['rudra', 'mrityunjaya']);
  assert.equal(t.timings, '5:30 AM - 11:00 AM');
  assert.equal(t.n, 'Kashi Vishwanath Annex');

  /* unknown puja ids are dropped; an empty set is rejected */
  const empty = await call('POST', '/admin/temples', { token: at, body: { name: 'No puja hall', pujas: ['nosuch'] } });
  assert.equal(empty.status, 400, 'puja set required');

  /* PATCH: rename, retimings, swap pujas */
  const patched = await call('PATCH', '/admin/temples/' + t.id, { token: at, body: { name: 'Kashi Annex II', timings: '6:00 AM - 12:00 PM', pujas: ['rudra'] } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.temple.n, 'Kashi Annex II');
  assert.deepEqual(patched.json.temple.pujas, ['rudra']);

  /* audits: create + update recorded with the new actions */
  const audits = (await call('GET', '/admin/audit?limit=300', { token: at })).json.entries;
  assert.ok(audits.find((a) => a.action === 'temple.create' && a.entityId === t.id));
  const upd = audits.find((a) => a.action === 'temple.update' && a.entityId === t.id);
  assert.ok(upd, 'temple.update audited');

  /* delete the fresh temple: no bookings reference it, so it goes */
  const del = await call('DELETE', '/admin/temples/' + t.id, { token: at });
  assert.equal(del.status, 200);
  assert.equal((await call('GET', '/admin/temples', { token: at })).json.temples.some((x) => x.id === t.id), false);
  const audits2 = (await call('GET', '/admin/audit?limit=300', { token: at })).json.entries;
  assert.ok(audits2.find((a) => a.action === 'temple.delete' && a.entityId === t.id));

  /* access: customers and pandits never reach the CRUD surface */
  const ct = await login('customer'), pt = await login('pandit');
  assert.equal((await call('GET', '/admin/temples', { token: ct })).status, 403);
  assert.equal((await call('POST', '/admin/temples', { token: ct, body: { name: 'x', pujas: ['rudra'] } })).status, 403);
  assert.equal((await call('PATCH', '/admin/temples/t1', { token: pt, body: { name: 'hax' } })).status, 403);
  assert.equal((await call('DELETE', '/admin/temples/t1', { token: pt })).status, 403);
});

test('active flag gates the directory and new temple bookings; delete is protected', async () => {
  const at = await admin(), ct = await login('customer');

  /* booked first, so the delete attempt has a reference to protect */
  const okBooking = (await call('POST', '/bookings', { token: ct, body: bookingBody() })).json.booking;
  assert.ok(okBooking.templeId === 't1', 'temple booking created against a listed temple');

  /* delist → hidden from the customer state, refused for NEW temple bookings */
  const off = await call('PATCH', '/admin/temples/t1', { token: at, body: { active: false } });
  assert.equal(off.status, 200);
  assert.equal(off.json.temple.active, 0);
  const state = (await call('GET', '/state', { token: ct })).json;
  assert.equal(state.catalog.temples.some((x) => x.id === 't1'), false, 'delisted temple hidden from the directory');
  const refused = await call('POST', '/bookings', { token: ct, body: bookingBody({ date: dayPlus(22) }) });
  assert.equal(refused.status, 400, 'temple-mode booking refused while delisted');
  /* a puja offered ONLY by delisted temples is unavailable for temple mode */
  const t5 = await call('PATCH', '/admin/temples/t5', { token: at, body: { active: false } });
  assert.equal(t5.status, 200);
  const lakshmiOnly = await call('POST', '/quote', { body: { pujaId: 'lakshmi', mode: 'temple', date: dayPlus(22), slot: '10:00 AM' } });
  assert.equal(lakshmiOnly.status, 400, 'temple mode unavailable when no active temple offers the puja');

  /* delete with a booking reference → 409 with the deactivate pointer */
  const del = await call('DELETE', '/admin/temples/t1', { token: at });
  assert.equal(del.status, 409);
  assert.match(del.json.error, /Deactivate it instead/);

  /* relist → everything works again */
  await call('PATCH', '/admin/temples/t5', { token: at, body: { active: true } });
  const back = await call('PATCH', '/admin/temples/t1', { token: at, body: { active: true } });
  assert.equal(back.json.temple.active, 1);
  const state2 = (await call('GET', '/state', { token: ct })).json;
  assert.equal(state2.catalog.temples.some((x) => x.id === 't1'), true, 'relisted temple back in the directory');
  const again = await call('POST', '/bookings', { token: ct, body: bookingBody({ date: dayPlus(23) }) });
  assert.equal(again.status, 201, 'temple booking accepted after relisting');
  assert.equal((await call('POST', '/quote', { body: { pujaId: 'lakshmi', mode: 'temple', date: dayPlus(23), slot: '10:00 AM' } })).status, 200);

  /* deleting the booking-less temple still works after the re-seed round trip */
  const fresh = (await call('POST', '/admin/temples', { token: at, body: { name: 'Ephemeral Shrine', pujas: ['rudra'] } })).json.temple;
  assert.equal((await call('DELETE', '/admin/temples/' + fresh.id, { token: at })).status, 200);
});
