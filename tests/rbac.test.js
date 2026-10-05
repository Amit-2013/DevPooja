/* Phase 21 — RBAC: sub-roles and the permission matrix (server/lib/permissions.js),
   twin of backend-python/tests/test_rbac.py. Covers: the admin family
   (admin/finance/customer_support) is the only way into /api/admin; finance gets
   the money group plus finance-domain exports only; customer_support gets the
   service group and never an export; platform routes and every other export stay
   full-admin; POST /users/:id/role hands out seats with reason/self/conflict/
   last-active-admin guards, audited old→new, live tokens picking the change up
   immediately; and /state serves the admin payload to the whole family.
   Harness parity with tests/tickets.test.js. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-rbac-'));
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
const demo = async (role) => (await call('POST', '/auth/demo', { body: { role } })).json.token;
const adminLogin = async () => (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
const adminId = () => db.prepare("SELECT id FROM users WHERE email='admin@daivikpuja.in'").get().id;
/* An operations seat: OTP-created customer, then the role written straight to the
   DB (the handout endpoint is exercised on its own). authenticate() re-reads the
   role per request, so the fresh token acts as the seat immediately. */
const seat = async (mobile, role) => {
  await call('POST', '/auth/otp/send', { body: { mobile } });
  const tok = (await call('POST', '/auth/otp/verify', { body: { mobile, otp: '123456', name: 'RBAC Probe' } })).json.token;
  const uid = db.prepare('SELECT id FROM users WHERE mobile=?').get(mobile).id;
  if (role !== 'customer') db.prepare('UPDATE users SET role=? WHERE id=?').run(role, uid);
  return { tok, uid };
};
const mkTicket = async (tok) => {
  const r = await call('POST', '/tickets', { token: tok, body: { t: 'RBAC probe: the pandit never arrived for the booking.', b: '' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
};

test('the family gate: anonymous 401, customer and pandit 403, sub-roles enter', async () => {
  const anon = await call('GET', '/admin/ledger');
  assert.equal(anon.status, 401);
  assert.equal(anon.json.error, 'Please log in');

  const cust = await demo('customer');
  const blocked = await call('GET', '/admin/ledger', { token: cust });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error, 'Not allowed', 'a customer is outside the admin family');
  assert.equal((await call('GET', '/admin/export/payments.xlsx', { token: cust })).status, 403);

  const pandit = await demo('pandit');
  const px = await call('GET', '/admin/export/payments.xlsx', { token: pandit });
  assert.equal(px.status, 403, 'a pandit never reaches an export');

  const finance = await seat('9811100201', 'finance');
  assert.equal((await call('GET', '/admin/ledger', { token: finance.tok })).status, 200, 'finance enters the router');
});

test('finance: the money group only — support/platform 403, exports limited to finance reports', async () => {
  const finance = await seat('9811100202', 'finance');
  const customer = await demo('customer');
  const tid = await mkTicket(customer);

  assert.equal((await call('GET', '/admin/ledger', { token: finance.tok })).status, 200, 'ledger is money');
  const sup = await call('GET', '/admin/tickets/' + tid, { token: finance.tok });
  assert.equal(sup.status, 403);
  assert.equal(sup.json.error, 'Not allowed for your role', 'support routes are closed to finance');
  assert.equal((await call('GET', '/admin/media', { token: finance.tok })).status, 403, 'platform is admin-only');
  assert.equal((await call('POST', '/admin/settings', { token: finance.tok, body: { k: 'probe' } })).status, 403);

  assert.equal((await call('GET', '/admin/export/payments.xlsx', { token: finance.tok })).status, 200, 'its own report exports');
  const no = await call('GET', '/admin/export/customers.xlsx', { token: finance.tok });
  assert.equal(no.status, 403, 'customer accounts sit outside the finance report list');
  assert.equal(no.json.error, 'Not allowed for your role');
});

test('customer_support: the service group only — money, platform and every export 403', async () => {
  const cs = await seat('9811100203', 'customer_support');
  const customer = await demo('customer');
  const tid = await mkTicket(customer);

  const d = await call('GET', '/admin/tickets/' + tid, { token: cs.tok });
  assert.equal(d.status, 200);
  assert.equal(d.json.ticket.st, 'OPEN');
  const tr = await call('POST', '/admin/tickets/' + tid + '/transition', { token: cs.tok, body: { status: 'UNDER_REVIEW' } });
  assert.equal(tr.status, 200, 'support drives the complaint machine');
  assert.equal(tr.json.ticket.st, 'UNDER_REVIEW');

  assert.equal((await call('GET', '/admin/ledger', { token: cs.tok })).status, 403, 'money is closed to support');
  assert.equal((await call('POST', '/admin/payouts/PO3/hold', { token: cs.tok, body: { reason: 'probe' } })).status, 403);
  assert.equal((await call('GET', '/admin/export/payments.xlsx', { token: cs.tok })).status, 403, 'support never exports');
  assert.equal((await call('GET', '/admin/media', { token: cs.tok })).status, 403);
  assert.equal((await call('POST', '/admin/settings', { token: cs.tok, body: {} })).status, 403);
});

test('the full admin keeps platform, money, support and every export', async () => {
  const a = await adminLogin();
  assert.equal((await call('GET', '/admin/ledger', { token: a })).status, 200);
  assert.equal((await call('GET', '/admin/media', { token: a })).status, 200);
  assert.equal((await call('GET', '/admin/export/customers.xlsx', { token: a })).status, 200, 'a non-finance report stays admin-only');
  const tid = await mkTicket(await demo('customer'));
  assert.equal((await call('GET', '/admin/tickets/' + tid, { token: a })).status, 200);
});

test('seat handout validates: reason required, no self-change, pandit not assignable', async () => {
  const a = await adminLogin();
  const { uid } = await seat('9811100204', 'customer');

  const noReason = await call('POST', '/admin/users/' + uid + '/role', { token: a, body: { role: 'finance' } });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.json.error, 'A reason is required');

  const self = await call('POST', '/admin/users/' + adminId() + '/role', { token: a, body: { role: 'customer', reason: 'probe' } });
  assert.equal(self.status, 400);
  assert.equal(self.json.error, 'You cannot change your own role');

  const badRole = await call('POST', '/admin/users/' + uid + '/role', { token: a, body: { role: 'pandit', reason: 'probe' } });
  assert.equal(badRole.status, 400, 'pandit is a portal profile, never an operations seat');
});

test('seat handout succeeds with an audited old→new and live tokens pick the role up at once', async () => {
  const a = await adminLogin();
  const { tok, uid } = await seat('9811100205', 'customer');

  const grant = await call('POST', '/admin/users/' + uid + '/role', { token: a, body: { role: 'finance', reason: 'Month-end payout duties' } });
  assert.equal(grant.status, 200, JSON.stringify(grant.json));
  assert.deepEqual(grant.json.user, { id: uid, role: 'finance' });

  const entries = (await call('GET', '/admin/audit', { token: a })).json.entries;
  const ev = entries.find((e) => e.action === 'account.role_changed' && String(e.entityId) === String(uid) && e.newValue === 'finance');
  assert.ok(ev, 'the seat change lands in the audit trail');
  assert.equal(ev.oldValue, 'customer');
  assert.equal(ev.reason, 'Month-end payout duties');

  assert.equal((await call('GET', '/admin/ledger', { token: tok })).status, 200, 'the same token is money-capable now');
  assert.equal((await call('GET', '/admin/media', { token: tok })).status, 403, 'but still not platform');

  const down = await call('POST', '/admin/users/' + uid + '/role', { token: a, body: { role: 'customer', reason: 'Duties ended' } });
  assert.equal(down.status, 200, JSON.stringify(down.json));
  assert.equal((await call('GET', '/admin/ledger', { token: tok })).status, 403, 'the demotion revokes the seat on the same live token');
});

test('seat handout guards: duplicate role 409, last active admin 409, sub-roles cannot grant', async () => {
  const a = await adminLogin();

  const dup = await seat('9811100206', 'customer');
  db.prepare("UPDATE users SET role='finance' WHERE id=?").run(dup.uid);
  const conflict = await call('POST', '/admin/users/' + dup.uid + '/role', { token: a, body: { role: 'finance', reason: 'probe' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error, 'That user already has this role');

  /* The caller cannot be an active admin for this count to reach 1 — demoting
     the only ACTIVE admin must refuse, whoever is asking. */
  const gov = await seat('9811100207', 'customer');
  db.prepare("UPDATE users SET role='admin', status='active' WHERE id=?").run(gov.uid);
  db.prepare("UPDATE users SET status='invited' WHERE id=?").run(adminId());
  const last = await call('POST', '/admin/users/' + gov.uid + '/role', { token: a, body: { role: 'customer', reason: 'probe' } });
  assert.equal(last.status, 409, 'the only active full admin cannot be demoted');
  assert.equal(last.json.error, 'At least one active admin must remain');
  db.prepare("UPDATE users SET status='active' WHERE id=?").run(adminId());

  const finance = await seat('9811100208', 'finance');
  const cs = await seat('9811100209', 'customer_support');
  const sub = await call('POST', '/admin/users/' + dup.uid + '/role', { token: finance.tok, body: { role: 'customer', reason: 'probe' } });
  assert.equal(sub.status, 403, 'seats are platform: full admins only');
  assert.equal(sub.json.error, 'Not allowed for your role');
  assert.equal((await call('POST', '/admin/users/' + dup.uid + '/role', { token: cs.tok, body: { role: 'customer', reason: 'probe' } })).status, 403);
});

test('/state: the whole family gets the admin payload, customers get their own', async () => {
  await seat('9811100210', 'customer');            /* a second customer row for the list */
  const finance = await seat('9811100211', 'finance');
  const cs = await seat('9811100212', 'customer_support');
  const customer = await demo('customer');

  for (const [role, tok] of [['finance', finance.tok], ['customer_support', cs.tok]]) {
    const st = (await call('GET', '/state', { token: tok })).json;
    assert.equal(st.session.role, role);
    assert.ok(st.users.length > 1, role + ' sees every customer row');
    assert.ok(st.set && st.set.comm !== undefined, role + ' sees the admin settings block');
  }
  const mine = (await call('GET', '/state', { token: customer })).json;
  assert.equal(mine.session.role, 'customer');
  assert.equal(mine.users.length, 1, 'a customer sees only themselves');
  assert.equal(mine.set.comm, undefined, 'the admin settings block stays out of customer state');
});
