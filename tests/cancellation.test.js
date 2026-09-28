/* Phase 16: cancellation & rescheduling engine — policy tiers from settings,
   pandit-side cancellation with notice-window compensation, no-show sweep +
   admin no-show (customer refund noshowPct + pandit compensation payout),
   audited policy CRUD. Harness parity with tests/ledger.test.js. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-cx-'));
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

const { db, tx } = require('../server/db');
const paidBooking = (ct, body) => call('POST', '/bookings', { token: ct, body });
const bookingRow = (id) => db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
const ledgerFor = (id, type) => db.prepare('SELECT * FROM transactions WHERE booking_id=? AND type=? ORDER BY id').all(id, type);
const one = (sql, ...a) => tx(() => db.prepare(sql).get(...a))();

async function makePaid(ct, o = {}) {
  const c = await paidBooking(ct, bookingBody(o));
  assert.equal(c.status, 201, JSON.stringify(c.json));
  return c.json.booking;
}

test('policy CRUD: defaults served, validation, audit with old→new', async () => {
  const at = await admin();
  const g = (await call('GET', '/admin/cancellation-policy', { token: at })).json.policy;
  assert.equal(g.fullPct, 100); assert.equal(g.partPct, 75); assert.equal(g.latePct, 50);
  assert.equal(g.noshowPct, 25); assert.equal(g.compPct, 50); assert.equal(g.noticeHours, 24);
  assert.equal((await call('GET', '/admin/cancellation-policy', { token: await login('customer') })).status, 403, 'admin-only');
  assert.equal((await call('PUT', '/admin/cancellation-policy', { token: at, body: { full: 30, part: 60 } })).status, 400, 'full must exceed part');
  assert.equal((await call('PUT', '/admin/cancellation-policy', { token: at, body: { latePct: 101 } })).status, 400, '0..100 enforced');
  const u = await call('PUT', '/admin/cancellation-policy', { token: at, body: { full: 72, part: 48, latePct: 40, noshowPct: 30, compPct: 60, noticeHours: 12 } });
  assert.equal(u.status, 200);
  assert.equal(u.json.policy.full, 72);
  const audits = (await call('GET', '/admin/audit?limit=100', { token: at })).json.entries;
  assert.ok(audits.some((a) => a.action === 'settings.cancellation_policy'), 'policy update audited');
  /* restore defaults for later tests */
  await call('PUT', '/admin/cancellation-policy', { token: at, body: { full: 48, part: 24, latePct: 50, noshowPct: 25, compPct: 50, noticeHours: 24 } });
});

test('customer cancel keeps the legacy tiers from policy; refund ledger still written', async () => {
  const at = await admin(), ct = await login('customer');
  const b = await makePaid(ct);
  const total = b.q.total;
  /* >48h = full refund */
  const c1 = await call('POST', '/bookings/' + b.id + '/cancel', { token: ct, body: {} });
  assert.equal(c1.status, 200);
  assert.deepEqual(c1.json.booking.refund, { amt: total, pct: 100, state: 'Initiated' }, 'full tier above the window');
  const rf = ledgerFor(b.id, 'REFUND');
  assert.equal(rf.length, 1);
  assert.equal(rf[0].amount, -total);
  /* late tier honours the POLICY, not the hardcoded 50 */
  await call('PUT', '/admin/cancellation-policy', { token: at, body: { latePct: 33 } });
  const b2 = await makePaid(ct, { date: dayPlus(1), slot: '06:00 AM' });
  const c2 = await call('POST', '/bookings/' + b2.id + '/cancel', { token: ct, body: {} });
  assert.equal(c2.json.booking.refund.pct, 33, 'policy latePct applied');
  await call('PUT', '/admin/cancellation-policy', { token: at, body: { latePct: 50 } });
});

test('pandit cancel: customer refunded, compensation only outside the notice window', async () => {
  const at = await admin(), ct = await login('customer');
  const p1tok = (await call('POST', '/auth/demo', { body: { role: 'pandit' } })).json.token;
  /* noticeHours=0 → every cancel counts as outside the window → compensation */
  await call('PUT', '/admin/cancellation-policy', { token: at, body: { noticeHours: 0 } });
  const far = await makePaid(ct, { date: dayPlus(40) });
  const cf = await call('POST', '/pandit/bookings/' + far.id + '/cancel', { token: p1tok, body: { reason: 'Family emergency' } });
  assert.equal(cf.status, 200, JSON.stringify(cf.json));
  assert.equal(cf.json.booking.status, 'Cancelled');
  assert.ok(cf.json.booking.panditId, 'pandit stays attributed (QA metrics)');
  assert.equal(cf.json.booking.refund.pct, 100, 'customer refunded at the standard tier');
  assert.ok(one('SELECT id FROM payouts WHERE booking_id=? AND id LIKE ?', far.id, 'POC%'), 'compensation payout created outside the notice window');
  assert.ok(ledgerFor(far.id, 'DAKSHINA').some((r) => r.ref_table === 'payouts' && !String(r.ref_id).includes(':comp')), 'compensation DAKSHINA ledger entry exists');
  /* noticeHours = a year → every cancel is inside the window → no compensation */
  await call('PUT', '/admin/cancellation-policy', { token: at, body: { noticeHours: 8760 } });
  const near = await makePaid(ct, {});
  const cn = await call('POST', '/pandit/bookings/' + near.id + '/cancel', { token: p1tok, body: {} });
  assert.equal(cn.status, 200);
  assert.equal(one('SELECT COUNT(*) c FROM payouts WHERE booking_id=? AND id LIKE ?', near.id, 'POC%').c, 0, 'no compensation inside the notice window');
  await call('PUT', '/admin/cancellation-policy', { token: at, body: { noticeHours: 24 } });
  /* started pujas cannot be pandit-cancelled */
  const st = await makePaid(ct, {});
  await call('POST', '/admin/bookings/' + st.id + '/status', { token: at, body: { status: 'Started' } });
  assert.equal((await call('POST', '/pandit/bookings/' + st.id + '/cancel', { token: p1tok, body: {} })).status, 400, 'started is refused');
  /* admin no-show for the started booking closes it instead */
  const ns = await call('POST', '/admin/bookings/' + st.id + '/noshow', { token: at, body: { reason: 'test' } });
  assert.equal(ns.status, 200);
  assert.equal(ns.json.booking.status, 'Cancelled');
  const nsRefund = ledgerFor(st.id, 'REFUND');
  assert.equal(nsRefund.length, 1);
  assert.equal(nsRefund[0].amount, -Math.round(st.q.total * 25 / 100), 'no-show customer refund at noshowPct');
  const audits = (await call('GET', '/admin/audit?limit=200', { token: at })).json.entries;
  assert.ok(audits.some((a) => a.action === 'booking.cancelled_by_pandit'), 'pandit cancel audited');
  assert.ok(audits.some((a) => a.action === 'booking.noshow'), 'no-show audited');
  assert.ok(audits.some((a) => a.action === 'booking.cancelled'), 'every cancel audited by the single writer');
});

test('no-show sweep: past-due active bookings are cancelled, customer refunded, pandit compensated, idempotent', async () => {
  const CX = require('../server/services/cancellation');
  /* craft a past-due paid booking directly (the seed only has completed history) */
  tx(() => db.prepare(`INSERT INTO bookings(id,user_id,puja_id,mode,date,slot,addr,temple_id,pandit_id,pst,sam,pra,notes,member,coupon,q,status,pay,ops,media,created,log)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('DPPAST1', 'u1', 'satyanarayan', 'home', dayPlus(-3), '10:00 AM',
    JSON.stringify({ line: '1 Old Street', city: 'Delhi NCR', pin: '110001' }), null, 'p1', 'accepted', '[]', '[]', '', 'Self', '',
    JSON.stringify({ svc: 2000, total: 2509 }), 'Confirmed', JSON.stringify({ paid: true, method: 'UPI', ref: 'MOCKX1' }), '{}', '[]', Date.now(), '[]'))();
  tx(() => db.prepare("INSERT INTO transactions(type,amount,currency,ref_table,ref_id,booking_id,note,created_at) VALUES('SERVICE_PAYMENT',2509,'INR','bookings','DPPAST1','DPPAST1','test',?)").run(Date.now()))();

  const first = await CX.panditNoShowSweep(null);
  assert.ok(first.includes('DPPAST1'), 'past-due booking swept: ' + JSON.stringify(first));
  const row = bookingRow('DPPAST1');
  assert.equal(row.status, 'Cancelled');
  assert.equal(JSON.parse(row.refund).pct, 25, 'customer refunded at noshowPct');
  const comp = one('SELECT amount FROM payouts WHERE booking_id=? AND id LIKE ?', 'DPPAST1', 'POC%');
  assert.ok(comp && comp.amount > 0, 'pandit compensation payout created');
  const second = await CX.panditNoShowSweep(null);
  assert.equal(second.includes('DPPAST1'), false, 'sweep is idempotent');
  assert.equal(ledgerFor('DPPAST1', 'REFUND').length, 1, 'no double refund');
});
