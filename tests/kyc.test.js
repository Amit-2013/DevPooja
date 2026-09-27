/* Phases 4 + 22: per-document KYC management and the pandit account lifecycle.
   Runs against the real Express app + a fresh SQLite DB per run. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-kyc-'));
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
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x11, 0x22, 0x33, 0x44]);

test('kyc: per-document upload, decisions, expiry, reminders, supersede', async () => {
  const tp = await login('pandit');
  const admin = (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;

  /* upload AADHAAR */
  let fd = new FormData();
  fd.append('doc', new Blob([jpeg], { type: 'image/jpeg' }), 'aadhaar.jpg');
  fd.append('docType', 'AADHAAR');
  const up = await fetch(base + '/api/pandit/kyc/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + tp }, body: fd });
  assert.equal(up.status, 201);
  const doc = (await up.json()).document;
  assert.equal(doc.status, 'PENDING');
  assert.equal(doc.docType, 'AADHAAR');

  /* explicit PENDING -> UNDER_REVIEW (Begin review); reason is not required */
  const b2r = await call('POST', `/admin/kyc/${doc.id}/decide`, { token: admin, body: { status: 'UNDER_REVIEW' } });
  assert.equal(b2r.json.document.status, 'UNDER_REVIEW');
  const b2a = await call('POST', `/admin/kyc/${doc.id}/decide`, { token: admin, body: { status: 'VERIFIED', expiresAt: Date.now() + 30 * 86400000 } });
  assert.equal(b2a.json.document.status, 'VERIFIED');

  /* admin summary sees it; verify with expiry */
  let sum = (await call('GET', '/admin/kyc', { token: admin })).json;
  assert.equal(sum.counts.PENDING, 0);
  const dec = await call('POST', `/admin/kyc/${doc.id}/decide`, { token: admin, body: { status: 'VERIFIED', expiresAt: Date.now() + 30 * 86400000 } });
  assert.equal(dec.json.document.status, 'VERIFIED');
  assert.ok(dec.json.document.expiresAt);

  /* reject without reason is refused; re-upload supersedes the pending copy */
  fd = new FormData();
  fd.append('doc', new Blob([jpeg], { type: 'image/jpeg' }), 'pan.jpg');
  fd.append('docType', 'PAN');
  const up2 = await fetch(base + '/api/pandit/kyc/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + tp }, body: fd });
  const pan = (await up2.json()).document;
  const noReason = await call('POST', `/admin/kyc/${pan.id}/decide`, { token: admin, body: { status: 'REJECTED' } });
  assert.equal(noReason.status, 400);
  const rej = await call('POST', `/admin/kyc/${pan.id}/decide`, { token: admin, body: { status: 'REJECTED', reason: 'Blurry photo' } });
  assert.equal(rej.json.document.rejectReason, 'Blurry photo');

  /* request re-upload requires a reason; re-upload supersedes */
  const rev = await call('POST', `/admin/kyc/${doc.id}/decide`, { token: admin, body: { status: 'REVERIFICATION_REQUIRED', reason: 'Name mismatch' } });
  assert.equal(rev.json.document.status, 'REVERIFICATION_REQUIRED');
  fd = new FormData();
  fd.append('doc', new Blob([jpeg], { type: 'image/jpeg' }), 'aadhaar2.jpg');
  fd.append('docType', 'AADHAAR');
  const up3 = await fetch(base + '/api/pandit/kyc/documents', { method: 'POST', headers: { Authorization: 'Bearer ' }, body: fd });
  assert.equal(up3.status, 401, 'upload needs a pandit session');
  const up4 = await fetch(base + '/api/pandit/kyc/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + tp }, body: fd });
  assert.equal(up4.status, 201);
  const doc2 = (await up4.json()).document;
  assert.notEqual(doc2.id, doc.id, 'a new row is created');
  sum = (await call('GET', '/admin/kyc', { token: admin })).json;
  assert.ok(sum.docs.some((d) => d.id === doc.id && d.status === 'SUPERSEDED'), 'superseded row remains in history');

  /* auto-expiry sweep flips a past-due VERIFIED doc and reminds the pandit */
  const past = Date.now() - 86400000;
  await call('POST', `/admin/kyc/${doc2.id}/decide`, { token: admin, body: { status: 'VERIFIED', expiresAt: past } });
  const sum2 = (await call('GET', '/admin/kyc', { token: admin })).json;
  assert.ok(sum2.reminders.some((d) => d.id === doc2.id), 'expired doc lands in reminders');

  /* pandit sees own documents with the rejection reason */
  const mine = (await call('GET', '/pandit/kyc/documents', { token: tp })).json.documents;
  assert.ok(mine.length >= 3);
  assert.ok(mine.some((d) => d.status === 'REJECTED' && d.rejectReason === 'Blurry photo'));

  /* decisions audited with old -> new status */
  const audits = (await call('GET', '/admin/audit?limit=500', { token: admin })).json.entries.filter((a) => a.entity === 'kyc_document');
  assert.ok(audits.some((a) => a.action === 'kyc.decide' && a.detail.from === 'PENDING' && a.detail.to === 'VERIFIED'));
  assert.ok(audits.some((a) => a.action === 'kyc.decide' && a.detail.reason));
});

test('kyc expiry sweeper: boot wiring, env-tunable interval, tick flips past-due docs', async () => {
  const fs = require('fs');
  const KYC = require('../server/services/kyc');

  /* drift-catchers: the scheduler must stay wired and must never pin the process */
  assert.match(fs.readFileSync('server/index.js', 'utf8'), /startSweeper\(\)/,
    'server boot must arm the KYC sweeper (reminders fire without admin traffic)');
  assert.match(fs.readFileSync('server/services/kyc.js', 'utf8'), /\.unref\(\)/,
    'the sweeper interval must be unref\'d so it never keeps the process alive');

  /* interval env: 0 disables, arming is idempotent */
  process.env.KYC_SWEEP_MS = '0';
  assert.equal(KYC.startSweeper(), null, 'KYC_SWEEP_MS=0 disables the scheduler');
  process.env.KYC_SWEEP_MS = '50';
  const timer = KYC.startSweeper();
  assert.ok(timer, 'sweeper armed with a positive interval');
  assert.equal(KYC.startSweeper(), timer, 'idempotent: one timer per process');
  KYC.stopSweeper();
  delete process.env.KYC_SWEEP_MS;

  /* tick() (the unit the interval calls) flips a past-due VERIFIED doc */
  const tp = await login('pandit');
  const admin = (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
  const fd = new FormData();
  fd.append('doc', new Blob([jpeg], { type: 'image/jpeg' }), 'sweep.jpg');
  fd.append('docType', 'TRAINING');
  const up = await fetch(base + '/api/pandit/kyc/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + tp }, body: fd });
  const doc = (await up.json()).document;
  await call('POST', `/admin/kyc/${doc.id}/decide`, { token: admin, body: { status: 'VERIFIED', expiresAt: Date.now() - 86400000 } });
  const flipped = KYC.tick();
  assert.ok(flipped >= 1, 'tick expired the past-due document');
  const audits = (await call('GET', '/admin/audit?limit=200', { token: admin })).json.entries.filter((a) => a.entityId === doc.id);
  assert.ok(audits.some((a) => a.action === 'kyc.auto_expire'));
});

test('account lifecycle: suspend blocks login + holds payouts; terminate is final; reinstate restores', async () => {
  const admin = (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
  const tp = await login('pandit'); // p1 (demo seed gives p1 a PENDING payout)

  /* suspension without a documented reason is refused */
  const noReason = await call('POST', '/admin/pandits/p1/lifecycle', { token: admin, body: { lifecycle: 'SUSPENDED' } });
  assert.equal(noReason.status, 400);

  const susp = await call('POST', '/admin/pandits/p1/lifecycle', { token: admin, body: { lifecycle: 'SUSPENDED', reason: 'Policy Violation', to: '2030-01-01', reviewDate: '2026-12-01' } });
  assert.equal(susp.json.lifecycle, 'SUSPENDED');

  /* login is blocked immediately: the DB re-check in authenticate() revokes the
     existing token (403) and fresh logins are refused too (009 semantics). */
  const st = await call('GET', '/state', { token: tp });
  assert.equal(st.status, 403);
  assert.match(st.json.error, /suspended/);

  /* open payouts are ON HOLD with the documented reason */
  const ast = (await call('GET', '/state', { token: admin })).json;
  const held = ast.payouts.filter((p) => p.p === 'p1' && p.st === 'ON_HOLD');
  assert.ok(held.length >= 1, 'open payouts held on suspension');
  assert.ok(held.every((p) => p.hr === 'Admin Hold' && /Policy Violation/.test(p.hn || '')));

  const adminView = (await call('GET', '/admin/pandit-lifecycle', { token: admin })).json.pandits.find((p) => p.id === 'p1');
  assert.equal(adminView.lifecycle, 'SUSPENDED');
  assert.equal(adminView.reason, 'Policy Violation');

  /* terminated is final */
  const term = await call('POST', '/admin/pandits/p1/lifecycle', { token: admin, body: { lifecycle: 'TERMINATED', reason: 'Fraud Concern' } });
  assert.equal(term.json.lifecycle, 'TERMINATED');
  const reinstate = await call('POST', '/admin/pandits/p1/lifecycle', { token: admin, body: { lifecycle: 'ACTIVE' } });
  assert.equal(reinstate.status, 409, 'terminated accounts cannot be reinstated');

  /* a different pandit (p2) round-trips suspend -> reinstate cleanly */
  const susp2 = await call('POST', '/admin/pandits/p2/lifecycle', { token: admin, body: { lifecycle: 'SUSPENDED', reason: 'KYC Issue' } });
  assert.equal(susp2.json.lifecycle, 'SUSPENDED');
  const ok = await call('POST', '/bookings', { token: await login('customer'), body: { pujaId: 'rudra', mode: 'home', date: new Date(Date.now() + 95 * 86400000).toISOString().slice(0, 10), slot: '10:00 AM', addr: { line: '1 T', city: 'Chennai', pin: '600005' }, panditId: 'p2', sam: [], pra: [] } });
  assert.equal(ok.status, 409, 'suspended pandit is not bookable');
  const rein2 = await call('POST', '/admin/pandits/p2/lifecycle', { token: admin, body: { lifecycle: 'ACTIVE' } });
  assert.equal(rein2.json.lifecycle, 'ACTIVE');
  const ok2 = await call('POST', '/bookings', { token: await login('customer'), body: { pujaId: 'rudra', mode: 'home', date: new Date(Date.now() + 96 * 86400000).toISOString().slice(0, 10), slot: '10:00 AM', addr: { line: '1 T', city: 'Chennai', pin: '600005' }, panditId: 'p2', sam: [], pra: [] } });
  assert.equal(ok2.status, 201, 'bookable again after reinstatement');

  /* lifecycle transitions audited */
  const audits = (await call('GET', '/admin/audit?limit=500', { token: admin })).json.entries.filter((a) => a.action === 'pandit.lifecycle');
  assert.ok(audits.some((a) => a.detail.to === 'SUSPENDED' && a.detail.reason));
  assert.ok(audits.some((a) => a.detail.to === 'TERMINATED'));
});
