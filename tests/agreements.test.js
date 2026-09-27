/* Phases 23-25: agreement versioning, publishing + hash, digital acceptance
   (OTP + IP + device into the enriched audit log), archive protection and the
   manual upload path. Runs against the real Express app + a fresh SQLite DB. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-agr-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
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
const pdf = Buffer.from('%PDF-1.4\n%fake-signed-agreement\n');

test('agreements: versioned publishing, hash, acceptance (OTP/IP/device), archive guard, manual upload', async () => {
  const a = await admin(), tp = await login('pandit');
  const body1 = 'Pandit partner agreement v1. The pandit commits to the code of conduct.';

  /* create draft (v1) */
  const d1 = await call('POST', '/admin/agreements', { token: a, body: { title: 'Pandit partner agreement', body: body1 } });
  assert.equal(d1.status, 201);
  assert.equal(d1.json.agreement.version, 1, 'first version is 1');
  assert.equal(d1.json.agreement.status, 'DRAFT');
  const noBody = await call('POST', '/admin/agreements', { token: a, body: { title: 'x', body: '  ' } });
  assert.equal(noBody.status, 400, 'empty body refused');

  /* pandit cannot see or accept anything before publication */
  assert.equal((await call('GET', '/pandit/agreement', { token: tp })).json.current, null);
  const early = await call('POST', '/pandit/agreement/accept', { token: tp, body: { agreementId: d1.json.agreement.id, consent: true, otp: '123456' } });
  assert.equal(early.status, 404, 'unpublished agreement is not visible to pandits');

  /* publish stamps sha256(body) */
  const p1 = await call('POST', `/admin/agreements/${d1.json.agreement.id}/publish`, { token: a, body: {} });
  assert.equal(p1.json.agreement.status, 'PUBLISHED');
  assert.equal(p1.json.agreement.documentHash, crypto.createHash('sha256').update(body1).digest('hex'), 'published hash is sha256(body)');
  const republish = await call('POST', `/admin/agreements/${d1.json.agreement.id}/publish`, { token: a, body: {} });
  assert.equal(republish.status, 409, 'double publish refused');

  /* pandit sees the current agreement; consent + OTP are enforced */
  const cur = (await call('GET', '/pandit/agreement', { token: tp })).json;
  assert.equal(cur.current.version, 1);
  const noConsent = await call('POST', '/pandit/agreement/accept', { token: tp, body: { agreementId: cur.current.id, consent: false, otp: '123456' } });
  assert.equal(noConsent.status, 400, 'acceptance without the consent box refused');
  const noOtp = await call('POST', '/pandit/agreement/accept', { token: tp, body: { agreementId: cur.current.id, consent: true } });
  assert.equal(noOtp.status, 400, 'acceptance without OTP refused');

  /* wrong OTP is rejected (the auth.js verifyOtp path) */
  const wrong = await call('POST', '/pandit/agreement/accept', { token: tp, body: { agreementId: cur.current.id, consent: true, otp: '000000' } });
  assert.equal(wrong.status, 400, 'wrong OTP refused');

  /* correct OTP (demo = 123456, sent to the pandit's registered mobile) accepts */
  const sent = await call('POST', '/auth/otp/send', { body: { mobile: '9810000001' } });
  assert.equal(sent.status, 200, 'OTP send works against the registered mobile (p1 seed mobile)');
  const acc = await call('POST', '/pandit/agreement/accept', { token: tp, body: { agreementId: cur.current.id, consent: true, otp: '123456' } });
  assert.equal(acc.status, 200);
  assert.equal(acc.json.acceptance.otpVerified, true);
  assert.equal(acc.json.acceptance.method, 'DIGITAL');
  assert.ok(acc.json.acceptance.ip, 'IP captured');
  assert.ok(acc.json.acceptance.device, 'device captured');

  /* version lock: accepting the same version twice is 409 */
  await call('POST', '/auth/otp/send', { body: { mobile: '9810000001' } });
  const dup = await call('POST', '/pandit/agreement/accept', { token: tp, body: { agreementId: cur.current.id, consent: true, otp: '123456' } });
  assert.equal(dup.status, 409, 'second acceptance of the same version refused');

  /* the enriched audit log carries the acceptance with IP + device */
  const audits = (await call('GET', '/admin/audit?limit=500', { token: a })).json.entries.filter((x) => x.action === 'agreement.accepted');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].ip, acc.json.acceptance.ip);
  assert.equal(audits[0].device, acc.json.acceptance.device);
  assert.ok(audits[0].newValue.version === 1, 'audit links the acceptance to the version');
  assert.ok((await call('GET', '/admin/audit?limit=500', { token: a })).json.entries.some((x) => x.action === 'agreement.published' && x.newValue.hash), 'publish audited with the hash');

  /* accepted versions cannot be archived; a new version supersedes instead */
  const archRefused = await call('POST', `/admin/agreements/${cur.current.id}/archive`, { token: a, body: {} });
  assert.equal(archRefused.status, 409, 'archiving an accepted version refused');

  /* v2 draft + publish; v2 becomes current, v1 keeps its acceptances */
  const d2 = await call('POST', '/admin/agreements', { token: a, body: { title: 'Pandit partner agreement', body: 'v2 text — revised commission schedule.', effectiveFrom: '2026-10-01' } });
  assert.equal(d2.json.agreement.version, 2, 'version increments per document family');
  const p2 = await call('POST', `/admin/agreements/${d2.json.agreement.id}/publish`, { token: a, body: {} });
  const cur2 = (await call('GET', '/pandit/agreement', { token: tp })).json;
  assert.equal(cur2.current.version, 2);
  assert.equal(cur2.myAcceptances.length, 1, 'old acceptance history remains visible');
  assert.equal(cur2.myAcceptances[0].version, 1);
  const list = (await call('GET', '/admin/agreements', { token: a })).json;
  assert.equal(list.agreements.length, 2);
  assert.equal(list.current.version, 2);
  assert.ok(list.agreements.find((x) => x.version === 1).acceptanceCount === 1);

  /* an accepted DRAFT cannot be re-published either way; v1 is PUBLISHED so still refused */
  const arch1 = await call('POST', `/admin/agreements/${cur.current.id}/archive`, { token: a, body: {} });
  assert.equal(arch1.status, 409);

  /* unaccepted PUBLISHED version CAN be archived, then refused re-publish */
  const arch2 = await call('POST', `/admin/agreements/${d2.json.agreement.id}/archive`, { token: a, body: { reason: 'Typo in schedule' } });
  assert.equal(arch2.status, 200);
  assert.equal(arch2.json.agreement.status, 'ARCHIVED');
  const rep = await call('POST', `/admin/agreements/${d2.json.agreement.id}/publish`, { token: a, body: {} });
  assert.equal(rep.status, 409, 'archived version cannot be re-published');

  /* manual upload path: signed PDF becomes a published version with its own hash */
  const fd = new FormData();
  fd.append('doc', new Blob([pdf], { type: 'application/pdf' }), 'signed-v3.pdf');
  fd.append('title', 'Signed agreement (manual)');
  const up = await fetch(base + '/api/admin/agreements/file', { method: 'POST', headers: { Authorization: 'Bearer ' + a }, body: fd });
  assert.equal(up.status, 201);
  const upj = await up.json();
  assert.equal(upj.agreement.version, 3);
  assert.equal(upj.agreement.status, 'PUBLISHED');
  assert.equal(upj.agreement.documentHash, crypto.createHash('sha256').update(pdf).digest('hex'), 'manual upload hashes the file bytes');
  assert.ok(upj.agreement.fileName);
  const forgery = await fetch(base + '/api/admin/agreements/file', { method: 'POST', headers: { Authorization: 'Bearer ' + a }, body: (() => { const f2 = new FormData(); f2.append('doc', new Blob([Buffer.from('not-a-pdf')], { type: 'application/pdf' }), 'fake.pdf'); f2.append('title', 'x'); return f2; })() });
  assert.equal(forgery.status, 400, 'file content must match its claimed type');

  /* pandit cannot create, publish, archive, upload or list admin agreement data */
  assert.equal((await call('GET', '/admin/agreements', { token: tp })).status, 403);
  assert.equal((await call('POST', '/admin/agreements', { token: tp, body: { title: 'x', body: 'y' } })).status, 403);
  assert.equal((await call('POST', `/admin/agreements/${upj.agreement.id}/archive`, { token: tp, body: {} })).status, 403);
  assert.equal((await call('GET', `/admin/agreements/${upj.agreement.id}/acceptances`, { token: tp })).status, 403);

  /* admin acceptance registry for a version */
  const acc1 = (await call('GET', `/admin/agreements/${cur.current.id}/acceptances`, { token: a })).json.acceptances;
  assert.equal(acc1.length, 1);
  assert.equal(acc1[0].method, 'DIGITAL');
  assert.ok(acc1[0].panditName, 'pandit name joined for the screen');
});
