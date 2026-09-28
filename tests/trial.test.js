/* Phase 18: trial poojas — the activation gate. Schedule → all-7 scoring →
   PASSED unlocks activation; FAILED/REASSESSMENT_REQUIRED and missing trials
   block it. Harness parity with tests/cancellation.test.js. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-trial-'));
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
const ALL7 = { punctuality: 4, communication: 4, ritualCompliance: 4, presentation: 4, customerInteraction: 4, digitalCapability: 4, documentation: 4 };

test('trial lifecycle: schedule → gate blocked → all-7 score → PASSED unlocks activation', async () => {
  const at = await admin();
  /* p6 is a seeded verified pandit; p2/p3 exist; use a pending-state pandit flow:
     the gate only fires on the transition INTO verified, so reject p6 first to
     exercise the whole path (seed data is disposable demo state). */
  const p6 = (await call('GET', '/state', { token: at })).json.pandits.find((p) => p.id === 'p6');
  assert.ok(p6, 'seed pandit p6 exists');
  await call('POST', '/admin/pandits/p6/kyc', { token: at, body: { status: 'rejected', reason: 'Re-running the activation flow in a test' } });

  /* gate: no trial at all */
  const blocked = await call('POST', '/admin/pandits/p6/kyc', { token: at, body: { status: 'verified' } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error, /No trial pooja has been assessed/);

  const s = await call('POST', '/admin/trials', { token: at, body: { panditId: 'p6', date: '2026-10-15', service: 'Satyanarayan Katha (home)' } });
  assert.equal(s.status, 201);
  assert.equal(s.json.trial.result, 'PENDING');
  assert.equal((await call('POST', '/admin/trials', { token: at, body: { panditId: 'p6', date: 'nope' } })).status, 400, 'date validated');
  assert.equal((await call('POST', '/admin/trials', { token: at, body: { panditId: 'p6', date: '2026-10-15' } })).status, 400, 'service required');
  assert.equal((await call('POST', '/admin/trials', { token: at, body: { panditId: 'nope', date: '2026-10-15', service: 'x' } })).status, 404);

  /* gate: scheduled but not assessed */
  const blocked2 = await call('POST', '/admin/pandits/p6/kyc', { token: at, body: { status: 'verified' } });
  assert.equal(blocked2.status, 409);
  assert.match(blocked2.json.error, /has not been assessed yet/);

  /* partial scoring refused — an activation decision never rests on a partial picture */
  const partial = { ...ALL7 }; delete partial.documentation;
  const pr = await call('POST', '/admin/trials/' + s.json.trial.id + '/record', { token: at, body: { scores: partial } });
  assert.equal(pr.status, 400);
  assert.match(pr.json.error, /documentation/i);
  assert.equal((await call('POST', '/admin/trials/' + s.json.trial.id + '/record', { token: at, body: { scores: { ...ALL7, punctuality: 9 } } })).status, 400, '1..5 enforced');

  /* full score below the pass mark → FAILED (even with all 7 recorded) */
  const low = await call('POST', '/admin/trials/' + s.json.trial.id + '/record', { token: at, body: { scores: { ...ALL7, punctuality: 2, communication: 3, presentation: 2, customerInteraction: 3 } } });
  assert.equal(low.status, 200);
  assert.equal(low.json.trial.result, 'FAILED', 'mean < 3.5 fails');

  /* gate: latest trial FAILED */
  const blocked3 = await call('POST', '/admin/pandits/p6/kyc', { token: at, body: { status: 'verified' } });
  assert.equal(blocked3.status, 409);
  assert.match(blocked3.json.error, /ended FAILED/);

  /* new trial, strong scores → PASSED → gate opens */
  const s2 = await call('POST', '/admin/trials', { token: at, body: { panditId: 'p6', date: '2026-11-01', service: 'Ganesh Puja (home)' } });
  const rec = await call('POST', '/admin/trials/' + s2.json.trial.id + '/record', { token: at, body: { scores: ALL7 } });
  assert.equal(rec.status, 200);
  assert.equal(rec.json.trial.result, 'PASSED');
  assert.equal(rec.json.trial.finalScore, 4);

  const ok = await call('POST', '/admin/pandits/p6/kyc', { token: at, body: { status: 'verified' } });
  assert.equal(ok.status, 200, 'activation allowed after a PASSED trial');

  /* re-verify while already verified is NOT gated (grandfathered transitions) */
  const again = await call('POST', '/admin/pandits/p6/kyc', { token: at, body: { status: 'verified' } });
  assert.equal(again.status, 200);

  const audits = (await call('GET', '/admin/audit?limit=300', { token: at })).json.entries;
  const acts = audits.map((a) => a.action);
  assert.ok(acts.includes('trial.scheduled'), 'schedule audited');
  assert.ok(acts.filter((a) => a === 'trial.recorded').length >= 2, 'both assessments audited');
  const list = (await call('GET', '/admin/trials?panditId=p6', { token: at })).json.trials;
  assert.equal(list.length, 2);
  const cust = await login('customer');
  assert.equal((await call('GET', '/admin/trials', { token: cust })).status, 403, 'admin-only');
  const pt = await login('pandit');
  const mine = (await call('GET', '/pandit/me/trial', { token: pt })).json.trials;
  assert.ok(Array.isArray(mine), 'pandit self-view works');
});

test('REASSESSMENT_REQUIRED requires written feedback and blocks activation', async () => {
  const at = await admin();
  await call('POST', '/admin/pandits/p3/kyc', { token: at, body: { status: 'rejected', reason: 'Phase 18 gate test' } });
  const s = await call('POST', '/admin/trials', { token: at, body: { panditId: 'p3', date: '2026-10-20', service: 'Rudrabhishek (temple)' } });
  const noNotes = await call('POST', '/admin/trials/' + s.json.trial.id + '/record', { token: at, body: { scores: ALL7, forceResult: 'REASSESSMENT_REQUIRED' } });
  assert.equal(noNotes.status, 400, 'reassessment requires written feedback');
  const rec = await call('POST', '/admin/trials/' + s.json.trial.id + '/record', { token: at, body: { scores: ALL7, forceResult: 'REASSESSMENT_REQUIRED', notes: 'Mantra pronunciation drifted on the Sankalp; reassess after coaching.' } });
  assert.equal(rec.status, 200);
  assert.equal(rec.json.trial.result, 'REASSESSMENT_REQUIRED');
  const blocked = await call('POST', '/admin/pandits/p3/kyc', { token: at, body: { status: 'verified' } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error, /ended REASSESSMENT_REQUIRED/);
  /* bad forceResult refused */
  const s2 = await call('POST', '/admin/trials', { token: at, body: { panditId: 'p3', date: '2026-10-25', service: 'Retry' } });
  assert.equal((await call('POST', '/admin/trials/' + s2.json.trial.id + '/record', { token: at, body: { scores: ALL7, forceResult: 'PASSED' } })).status, 400, 'PASSED is computed, never forced');
});
