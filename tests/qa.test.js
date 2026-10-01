/* Phases 5 + 17: pandit profile enrichment + the QA & rating engine.
   Runs against the real Express app + a fresh SQLite DB per run (harness parity
   with tests/kyc.test.js). */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-qa-'));
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
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x11, 0x22, 0x33, 0x44]);

test('profile enrichment: fields save, photo uploads and serves, serializer exposes', async () => {
  const tp = await login('pandit');
  const patch = await call('PATCH', '/pandit/profile', { token: tp, body: { city: 'Varanasi', exp: 12, langs: 'Hindi, Sanskrit', bio: 'Vedic scholar', spec: 'rudra,ganesh', avail: true, gotra: 'Bharadwaj', quals: 'Shastri, Acharya', veda: 'Smarta' } });
  assert.equal(patch.status, 200);

  const fd = new FormData();
  fd.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), 'me.jpg');
  const up = await fetch(base + '/api/pandit/profile/photo', { method: 'POST', headers: { Authorization: 'Bearer ' + tp }, body: fd });
  assert.equal(up.status, 200);
  const photo = (await up.json()).photo;
  assert.match(photo, /^\/media\/prof-/);
  assert.equal((await fetch(base + photo)).status, 200, 'photo is publicly served from /media');

  const st = (await call('GET', '/state', { token: tp })).json;
  const me = st.pandits.find((p) => p.id === st.session.pid) || st.pandits[0];
  assert.equal(me.gotra, 'Bharadwaj');
  assert.equal(me.quals, 'Shastri, Acharya');
  assert.equal(me.veda, 'Smarta');
  assert.equal(me.photo, photo);
  assert.equal(me.qa, null, 'no QA score yet');
});

test('QA engine: record, overall = mean, score cache, validation, delete recomputes, audit', async () => {
  const at = await admin();
  const r1 = await call('POST', '/admin/qa', { token: at, body: { panditId: 'p1', punctuality: 5, ritualCompliance: 4, documentation: 3, notes: 'Good puja' } });
  assert.equal(r1.status, 201);
  assert.equal(r1.json.record.overall, 4, 'overall is the mean of the scored dimensions');

  const r2 = await call('POST', '/admin/qa', { token: at, body: { panditId: 'p1', punctuality: 3 } });
  assert.equal(r2.json.record.overall, 3);

  let view = (await call('GET', '/admin/pandits/p1/qa', { token: at })).json;
  assert.equal(view.qaScore, 3.5, 'cached score is the average across records');
  assert.equal(view.records.length, 2);
  assert.ok(view.derived.assigned >= 1);

  /* validation: 1..5 integer, at least one dimension, unknown pandit/booking */
  assert.equal((await call('POST', '/admin/qa', { token: at, body: { panditId: 'p1', punctuality: 11 } })).status, 400);
  assert.equal((await call('POST', '/admin/qa', { token: at, body: { panditId: 'p1', punctuality: 2.5 } })).status, 400);
  assert.equal((await call('POST', '/admin/qa', { token: at, body: { panditId: 'p1' } })).status, 400);
  assert.equal((await call('POST', '/admin/qa', { token: at, body: { panditId: 'nope', punctuality: 4 } })).status, 404);
  /* a real booking assigned to a DIFFERENT pandit is refused (404 if unknown) */
  const other = (await call('GET', '/state', { token: at })).json.bookings.find((b) => b.panditId && b.panditId !== 'p1');
  if (other) assert.equal((await call('POST', '/admin/qa', { token: at, body: { panditId: 'p1', bookingId: other.id, punctuality: 4 } })).status, 400);
  const cust = await login('customer');
  assert.equal((await call('GET', '/admin/qa', { token: cust })).status, 403, 'customers cannot read QA');

  /* delete recomputes the cached score; the deletion reason is audited */
  const del = await call('DELETE', '/admin/qa/' + r2.json.record.id, { token: at, body: { reason: 'Duplicate entry — recorded twice by mistake' } });
  assert.equal(del.status, 200);
  view = (await call('GET', '/admin/pandits/p1/qa', { token: at })).json;
  assert.equal(view.qaScore, 4, 'score recomputed after delete');
  assert.equal(view.records.length, 1);

  /* every write is audited */
  const audits = (await call('GET', '/admin/audit?limit=300', { token: at })).json.entries.filter((a) => a.action.startsWith('qa.'));
  assert.ok(audits.some((a) => a.action === 'qa.recorded'));
  assert.ok(audits.some((a) => a.action === 'qa.deleted' && (a.reason || '').includes('Duplicate entry')), 'the delete reason reaches the audit trail');

  /* pandit self-view: own records + derived metrics, no admin leakage */
  const tp = await login('pandit');
  const mine = (await call('GET', '/pandit/me/qa', { token: tp })).json;
  assert.ok(mine.records.length >= 1);
  assert.ok(mine.derived.assigned >= 1);
  assert.equal(typeof mine.derived.noShowPct, 'number');
});
