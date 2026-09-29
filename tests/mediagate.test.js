/* Phase 6: service photo date gate — pandit uploads are accepted only when
   booking.date == today, unless an admin grants the booking a media_override
   (audited as media.date_gate_override with old→new). The admin media view and
   the pandit portal both carry the gate facts: upload_date snapshot on every
   media row, uploadedBy/createdAt for attribution. Harness parity with
   tests/incident.test.js / tests/cancellation.test.js. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-mediagate-'));
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

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
const uploadTo = async (token, bookingId, altText = 'Phase 6 gate test photo') => {
  const fd = new FormData();
  fd.append('media', new Blob([png], { type: 'image/png' }), 'gate.png');
  fd.append('bookingId', bookingId);
  fd.append('altText', altText);
  const res = await fetch(base + '/api/pandit/media', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const auditEntries = (adminTok) => call('GET', '/admin/audit', { token: adminTok }).then((r) => r.json.entries);

test('pandit media upload passes the date gate only on the puja date', async () => {
  const ptok = await login('pandit');
  const mine = (await call('GET', '/state', { token: ptok })).json.bookings;

  /* seeded today-booking (p1, satyanarayan, day 0) uploads fine */
  const tb = mine.find((b) => b.date === dayPlus(0));
  assert.ok(tb, 'seeded today-dated booking exists');
  const ok = await uploadTo(ptok, tb.id);
  assert.equal(ok.status, 201, 'upload on the puja date is allowed: ' + JSON.stringify(ok.json).slice(0, 160));
  assert.equal(ok.json.media[0].uploadDate, dayPlus(0), 'upload_date snapshot stamped');

  /* future booking is refused with the pinned gate message */
  const fut = mine.find((b) => b.date === dayPlus(7));
  assert.ok(fut, 'seeded future-dated booking exists');
  const refused = await uploadTo(ptok, fut.id);
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error, 'Photos can only be uploaded on the scheduled puja date — ask the admin for an override');

  /* past booking is equally refused (Completed day -30 booking) */
  const past = mine.find((b) => b.date === dayPlus(-30));
  assert.ok(past);
  const refusedPast = await uploadTo(ptok, past.id);
  assert.equal(refusedPast.status, 400);
  assert.equal(refusedPast.json.error, 'Photos can only be uploaded on the scheduled puja date — ask the admin for an override');
});

test('admin media-override opens the gate; the flow is audited both ways', async () => {
  const atok = await admin(), ptok = await login('pandit');
  const fut = (await call('GET', '/state', { token: ptok })).json.bookings.find((b) => b.date === dayPlus(7));
  assert.ok(fut);

  /* still refused before the override */
  assert.equal((await uploadTo(ptok, fut.id)).status, 400);

  /* override → upload succeeds, marked as admin_override in the audit detail */
  const ov = await call('POST', '/admin/bookings/' + fut.id + '/media-override', { token: atok, body: { enable: true } });
  assert.equal(ov.status, 200);
  assert.equal(ov.json.booking.mediaOverride, true);
  const viaOverride = await uploadTo(ptok, fut.id);
  assert.equal(viaOverride.status, 201, 'override opens the gate: ' + JSON.stringify(viaOverride.json).slice(0, 160));
  assert.equal(viaOverride.json.media[0].uploadDate, dayPlus(7), 'snapshot keeps the real puja date');

  /* both flips audited with old→new */
  const entries = await auditEntries(atok);
  const grant = entries.find((a) => a.action === 'media.date_gate_override' && a.entityId === fut.id && a.newValue.mediaOverride === true);
  assert.ok(grant, 'override grant audited');
  assert.equal(grant.oldValue.mediaOverride, false);
  assert.equal(grant.role, 'admin');
  const upAudit = entries.find((a) => a.action === 'media.pandit_upload' && a.detail.bookingId === fut.id);
  assert.ok(upAudit, 'upload audited');
  assert.equal(upAudit.detail.dateGate, 'admin_override');

  /* revoke → upload refused again */
  const off = await call('POST', '/admin/bookings/' + fut.id + '/media-override', { token: atok, body: { enable: false } });
  assert.equal(off.status, 200);
  assert.equal(off.json.booking.mediaOverride, false);
  assert.equal((await uploadTo(ptok, fut.id)).status, 400);
  const entries2 = await auditEntries(atok);
  assert.ok(entries2.find((a) => a.action === 'media.date_gate_override' && a.entityId === fut.id && a.newValue.mediaOverride === false), 'revocation audited');
});

test('gate respects ownership and role; admin view shows upload timestamp and actor', async () => {
  const atok = await admin(), ctok = await login('customer');
  const fut = (await call('GET', '/state', { token: await login('pandit') })).json.bookings.find((b) => b.date === dayPlus(7));

  /* customers never reach the pandit upload endpoint */
  assert.equal((await uploadTo(ctok, fut.id)).status, 403);

  /* admin grants override, pandit uploads, admin list carries attribution */
  await call('POST', '/admin/bookings/' + fut.id + '/media-override', { token: atok, body: {} });
  const up = await uploadTo(await login('pandit'), fut.id, 'Attribution check photo');
  assert.equal(up.status, 201);
  const m = up.json.media[0];
  assert.ok(m.uploadedBy, 'uploadedBy recorded');
  assert.ok(m.createdAt > 0, 'upload timestamp recorded');

  const list = (await call('GET', '/admin/media?source=pandit', { token: atok })).json.media;
  const row = list.find((x) => x.id === m.id);
  assert.ok(row, 'admin media list shows the upload');
  assert.ok(row.uploadedBy && row.createdAt && row.uploadDate, 'timestamp + actor + puja date visible to admin');

  /* pandit's own list carries the snapshot too */
  const mineList = (await call('GET', '/pandit/media', { token: await login('pandit') })).json.media;
  assert.ok(mineList.some((x) => x.id === m.id && x.uploadDate === dayPlus(7)));

  /* unknown booking still 404s before any gate logic */
  assert.equal((await uploadTo(await login('pandit'), 'nosuchbooking')).status, 404);
});
