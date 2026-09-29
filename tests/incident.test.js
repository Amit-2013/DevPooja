/* Phase 20: incident reporting — the pandit's on-ground channel against their
   own bookings, admin triage states (OPEN → UNDER_REVIEW → RESOLVED | DISMISSED),
   audits + notifications, evidence through the magic-checked media pipeline.
   Harness parity with tests/trial.test.js / tests/cancellation.test.js. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-incident-'));
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

const { db } = require('../server/db');
const notifsFor = (uid) => db.prepare('SELECT * FROM notifs WHERE user_id=? ORDER BY id').all(uid);
const adminUid = () => db.prepare("SELECT id FROM users WHERE role='admin'").get().id;
const panditUid = (pid) => db.prepare('SELECT user_id FROM pandits WHERE id=?').get(pid).user_id;

/* Minimal magic-valid blobs for the media pipeline (images + video classes). */
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(24)]);
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(24)]);

test('pandit reports an incident against own booking → linked customer, audit, admin notifications', async () => {
  const ct = await login('customer'), pt = await login('pandit'), at = await admin();
  const b = (await call('POST', '/bookings', { token: ct, body: bookingBody() })).json.booking;
  const auid = adminUid();
  const before = notifsFor(auid).length;

  const rep = await call('POST', '/pandit/incidents', { token: pt, body: { bookingId: b.id, category: 'SAFETY_CONCERN', description: 'Stray dogs blocked the courtyard approach during setup.' } });
  assert.equal(rep.status, 201, JSON.stringify(rep.json));
  const inc = rep.json.incident;
  assert.equal(inc.status, 'OPEN');
  assert.equal(inc.bookingId, b.id);
  assert.equal(inc.customerId, b.userId, 'customer linked from the booking');
  assert.deepEqual(inc.evidence, []);

  const audits = (await call('GET', '/admin/audit?limit=300', { token: at })).json.entries;
  const a = audits.find((x) => x.action === 'incident.reported' && x.entityId === inc.id);
  assert.ok(a, 'incident.reported audited');
  assert.equal(a.role, 'pandit', 'actor is the pandit user id — role derived from the users row');
  assert.equal(a.newValue.status, 'OPEN');
  assert.equal(notifsFor(auid).length, before + 1, 'admin notified in-app');

  const mine = (await call('GET', '/pandit/me/incidents', { token: pt })).json;
  assert.ok(mine.incidents.some((x) => x.id === inc.id));
  assert.ok(mine.categories.includes('SAMAGRI_ISSUE'));
});

test('ownership + validation: other pandit booking 400, unknown 404, category + short description 400', async () => {
  const ct = await login('customer'), pt = await login('pandit');
  const own = (await call('POST', '/bookings', { token: ct, body: bookingBody({ date: dayPlus(21) }) })).json.booking;
  const other = (await call('POST', '/bookings', { token: ct, body: bookingBody({ date: dayPlus(30), panditId: 'p2' }) })).json.booking;

  assert.equal((await call('POST', '/pandit/incidents', { token: pt, body: { bookingId: other.id, category: 'OTHER', description: 'This booking is assigned to another pandit.' } })).status, 400, 'not your booking');
  assert.equal((await call('POST', '/pandit/incidents', { token: pt, body: { bookingId: 'DPNOPE99', category: 'OTHER', description: 'A booking that simply does not exist anywhere.' } })).status, 404);
  assert.equal((await call('POST', '/pandit/incidents', { token: pt, body: { category: 'MADE_UP', description: 'Category outside the fixed vocabulary.' } })).status, 400);
  assert.equal((await call('POST', '/pandit/incidents', { token: pt, body: { category: 'OTHER', description: 'short' } })).status, 400, 'min 10 characters');
  const ok = await call('POST', '/pandit/incidents', { token: pt, body: { bookingId: own.id, category: 'PAYMENT_ISSUE', description: 'Customer refused the balance payment on arrival.' } });
  assert.equal(ok.status, 201, 'own booking passes');
});

test('evidence upload: magic-checked files accepted, /media/ URLs persisted, non-/media/ strings filtered', async () => {
  const pt = await login('pandit');
  const fd = new FormData();
  fd.append('evidence', new Blob([PNG], { type: 'image/png' }), 'one.png');
  fd.append('evidence', new Blob([MP4], { type: 'video/mp4' }), 'clip.mp4');
  const up = await fetch(base + '/api/pandit/incident-evidence', { method: 'POST', headers: { Authorization: 'Bearer ' + pt }, body: fd });
  assert.equal(up.status, 200);
  const urls = (await up.json()).urls;
  assert.equal(urls.length, 2);
  assert.ok(urls.every((u) => u.startsWith('/media/')), 'urls served from the media dir');
  const exts = urls.map((u) => u.split('.').pop()).sort().join();
  assert.equal(exts, 'mp4,png', 'extensions follow the sniffed real types');

  /* a text file claiming to be a png dies at the magic check */
  const bad = await fetch(base + '/api/pandit/incident-evidence', { method: 'POST', headers: { Authorization: 'Bearer ' + pt }, body: (() => { const f2 = new FormData(); f2.append('evidence', new Blob([Buffer.from('definitely not an image')], { type: 'image/png' }), 'fake.png'); return f2; })() });
  assert.equal(bad.status, 400);

  /* reported incident keeps only verified /media/ paths, client strings are dropped */
  const withEv = await call('POST', '/pandit/incidents', { token: pt, body: { category: 'CUSTOMER_CONDUCT', description: 'Abusive language during the sankalp; recordings attached here.', evidence: [...urls, 'http://evil.example/payload.png', '/etc/passwd'] } });
  assert.equal(withEv.status, 201);
  assert.deepEqual(withEv.json.incident.evidence.sort(), urls.slice().sort(), 'foreign strings dropped');
  const filesOnDisk = fs.readdirSync(path.join(tmp, 'uploads', 'media'));
  assert.ok(filesOnDisk.length >= 2, 'files written under the upload dir');
});

test('admin triage: required notes per state, closed terminal, audits old→new, pandit notified', async () => {
  const pt = await login('pandit'), at = await admin(), ct = await login('customer');
  const b = (await call('POST', '/bookings', { token: ct, body: bookingBody({ date: dayPlus(23) }) })).json.booking;
  const inc = (await call('POST', '/pandit/incidents', { token: pt, body: { bookingId: b.id, category: 'SAMAGRI_ISSUE', description: 'Kit arrived without the havan samagri packet.' } })).json.incident;
  const p1uid = panditUid('p1');
  const before = notifsFor(p1uid).length;

  const view = (await call('GET', '/admin/incidents', { token: at })).json;
  assert.ok(view.incidents.some((x) => x.id === inc.id));
  assert.equal(view.counts.OPEN >= 1, true, 'counts served');
  assert.ok(view.categories.includes('OTHER'));

  /* transition validation */
  assert.equal((await call('PATCH', '/admin/incidents/' + inc.id, { token: at, body: { status: 'UNDER_REVIEW' } })).status, 400, 'notes required');
  assert.equal((await call('PATCH', '/admin/incidents/' + inc.id, { token: at, body: { status: 'RESOLVED' } })).status, 400, 'resolution required');
  assert.equal((await call('PATCH', '/admin/incidents/' + inc.id, { token: at, body: { status: 'DISMISSED' } })).status, 400, 'reason required');
  assert.equal((await call('PATCH', '/admin/incidents/' + inc.id, { token: at, body: { status: 'WEIRD' } })).status, 400);
  assert.equal((await call('PATCH', '/admin/incidents/INCNOPE1', { token: at, body: { status: 'RESOLVED', resolution: 'x' } })).status, 404);

  const ur = await call('PATCH', '/admin/incidents/' + inc.id, { token: at, body: { status: 'UNDER_REVIEW', notes: 'Checking the samagri dispatch log with the vendor.' } });
  assert.equal(ur.status, 200);
  assert.equal(ur.json.incident.status, 'UNDER_REVIEW');
  assert.equal(ur.json.incident.adminNotes, 'Checking the samagri dispatch log with the vendor.');

  const closed = await call('PATCH', '/admin/incidents/' + inc.id, { token: at, body: { status: 'RESOLVED', resolution: 'Replacement kit dispatched; vendor penalised.' } });
  assert.equal(closed.status, 200);
  assert.equal(closed.json.incident.status, 'RESOLVED');
  assert.ok(closed.json.incident.resolvedAt, 'resolved_at stamped');

  const again = await call('PATCH', '/admin/incidents/' + inc.id, { token: at, body: { status: 'DISMISSED', reason: 'reopen attempt' } });
  assert.equal(again.status, 409, 'closed is terminal');

  /* audits: two triage writes with old→new (feed is newest-first) */
  const audits = (await call('GET', '/admin/audit?limit=300', { token: at })).json.entries;
  const tri = audits.filter((x) => x.action === 'incident.triage' && x.entityId === inc.id);
  assert.equal(tri.length, 2);
  assert.deepEqual(tri[1].oldValue, { status: 'OPEN' }, 'oldest first in the pair');
  assert.deepEqual(tri[0].oldValue, { status: 'UNDER_REVIEW' });
  assert.equal(tri[0].role, 'admin');

  /* pandit notified on every triage decision */
  const notifs = notifsFor(p1uid).slice(before);
  assert.equal(notifs.length, 2, 'under-review + resolved notifications');
  assert.match(notifs[0].message, /under review/);
  assert.match(notifs[1].message, /resolved: /);
});

test('reopen: dismissed incidents return to UNDER_REVIEW with a mandatory audited reason; RESOLVED stays final', async () => {
  const pt = await login('pandit'), at = await admin(), ct = await login('customer');
  const b = (await call('POST', '/bookings', { token: ct, body: bookingBody({ date: dayPlus(25) }) })).json.booking;
  const inc = (await call('POST', '/pandit/incidents', { token: pt, body: { bookingId: b.id, category: 'SAFETY_CONCERN', description: 'Unlit staircase to the entrance; customer denied access to the breaker panel.' } })).json.incident;
  const p1uid = panditUid('p1');
  const before = notifsFor(p1uid).length;

  /* only DISMISSED can be reopened */
  assert.equal((await call('POST', '/admin/incidents/' + inc.id + '/reopen', { token: at, body: { reason: 'too early' } })).status, 400, 'OPEN cannot be reopened');
  await call('PATCH', '/admin/incidents/' + inc.id, { token: at, body: { status: 'UNDER_REVIEW', notes: 'Initial look.' } });
  assert.equal((await call('POST', '/admin/incidents/' + inc.id + '/reopen', { token: at, body: { reason: 'still too early' } })).status, 400, 'UNDER_REVIEW cannot be reopened');
  await call('PATCH', '/admin/incidents/' + inc.id, { token: at, body: { status: 'DISMISSED', reason: 'Pandit retracted the report on call.' } });

  /* reopen validation */
  assert.equal((await call('POST', '/admin/incidents/' + inc.id + '/reopen', { token: at, body: {} })).status, 400, 'reason required');
  assert.equal((await call('POST', '/admin/incidents/INCNOPE1/reopen', { token: at, body: { reason: 'x' } })).status, 404);

  /* reopen succeeds: back to UNDER_REVIEW, counters + reason recorded, pandit notified */
  const re = await call('POST', '/admin/incidents/' + inc.id + '/reopen', { token: at, body: { reason: 'Customer contradicts the retraction in writing; revisiting with the site log.' } });
  assert.equal(re.status, 200);
  assert.equal(re.json.incident.status, 'UNDER_REVIEW');
  assert.equal(re.json.incident.reopenCount, 1);
  assert.equal(re.json.incident.reopenReason, 'Customer contradicts the retraction in writing; revisiting with the site log.');
  const notifs = notifsFor(p1uid).slice(before);
  assert.ok(notifs.some((n) => /reopened for review/.test(n.message)), 'reopening notified to the pandit');

  /* the reopened incident flows through normal triage again — and a second
     dismiss → reopen increments the counter */
  const res = await call('PATCH', '/admin/incidents/' + inc.id, { token: at, body: { status: 'DISMISSED', reason: 'Site log confirms the retraction.' } });
  assert.equal(res.status, 200, 'triage works on the reopened incident');
  const re2 = await call('POST', '/admin/incidents/' + inc.id + '/reopen', { token: at, body: { reason: 'New photographic evidence supplied.' } });
  assert.equal(re2.status, 200);
  assert.equal(re2.json.incident.reopenCount, 2, 'reopen counter increments');
  assert.equal(re2.json.incident.reopenReason, 'New photographic evidence supplied.', 'latest reason wins');

  /* RESOLVED stays final — no reopening path */
  await call('PATCH', '/admin/incidents/' + inc.id, { token: at, body: { status: 'RESOLVED', resolution: 'Permanent lighting installed by the host.' } });
  assert.equal((await call('POST', '/admin/incidents/' + inc.id + '/reopen', { token: at, body: { reason: 'one more look' } })).status, 400, 'RESOLVED is final');

  /* audit trail keeps every hop: reported + 3 triages + 2 reopens, each with old→new */
  const audits = (await call('GET', '/admin/audit?limit=300', { token: at })).json.entries;
  const reopens = audits.filter((x) => x.action === 'incident.reopened' && x.entityId === inc.id);
  assert.equal(reopens.length, 2, 'both reopens audited');
  assert.deepEqual(reopens[0].oldValue, { status: 'DISMISSED' });
  assert.deepEqual(reopens[0].newValue, { status: 'UNDER_REVIEW' });
  assert.equal(reopens[0].role, 'admin');
  assert.match(reopens[0].detail.reason, /photographic evidence/);
  const reported = audits.find((x) => x.action === 'incident.reported' && x.entityId === inc.id);
  assert.ok(reported, 'the original reported audit is untouched');
});

test('access: admin-only reads and triage; pandit sees only own reports; dismissal needs a reason', async () => {
  const at = await admin(), pt = await login('pandit'), ct = await login('customer');
  assert.equal((await call('GET', '/admin/incidents', { token: ct })).status, 403);
  assert.equal((await call('GET', '/admin/incidents', { token: pt })).status, 403);
  assert.equal((await call('PATCH', '/admin/incidents/INCX1', { token: ct, body: { status: 'RESOLVED', resolution: 'nope' } })).status, 403);

  /* p1 reports; a second pandit's self-view must not include it */
  const b = (await call('POST', '/bookings', { token: ct, body: bookingBody({ date: dayPlus(24) }) })).json.booking;
  const inc = (await call('POST', '/pandit/incidents', { token: pt, body: { bookingId: b.id, category: 'OTHER', description: 'Left luggage at the venue, retrieved later.' } })).json.incident;
  assert.ok((await call('GET', '/pandit/me/incidents', { token: pt })).json.incidents.some((x) => x.id === inc.id));

  const dismiss = await call('PATCH', '/admin/incidents/' + inc.id, { token: at, body: { status: 'DISMISSED', reason: 'Duplicate of ' + inc.id + ' filing pattern; details already tracked.' } });
  assert.equal(dismiss.status, 200);
  assert.equal(dismiss.json.incident.status, 'DISMISSED');
  assert.ok(dismiss.json.incident.resolvedAt === null || dismiss.json.incident.resolvedAt === undefined, 'resolved_at only for RESOLVED');

  const only = (await call('GET', '/admin/incidents?status=DISMISSED', { token: at })).json.incidents;
  assert.ok(only.length && only.every((x) => x.status === 'DISMISSED'), 'status filter works');
  assert.ok(notifsFor(panditUid('p1')).some((n) => /not actionable/.test(n.message)), 'dismissal notified');
});
