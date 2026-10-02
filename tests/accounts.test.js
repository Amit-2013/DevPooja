/* NRI accounts + profile location (additional-requirements Phase A) — twin of
   backend-python/tests/test_accounts.py.
   The account type is asked at registration and stored on the SAME users row
   (never a second account, never a parallel auth path); location is optional,
   validated, editable and stored as only the fields the app needs. Switching
   the account type preserves every booking, order, address and family datum. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-acct-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../server/db');
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
const dayPlus = (n) => { const d = new Date(); d.setHours(12); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const bookingBody = (o = {}) => ({ pujaId: 'satyanarayan', mode: 'home', date: dayPlus(21), slot: '10:00 AM', addr: { line: '12 Test Street', city: 'Delhi NCR', pin: '110001' }, panditId: 'p1', sam: [], pra: [], ...o });
const signup = (email, accountType) => call('POST', '/auth/email', { body: { email, password: 'secret123', name: 'Phase A Probe', accountType } });
const admin = async () => (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;

test('registration: account type stored on the same account, duplicates never created', async () => {
  const r1 = await signup('phasea.nri@example.com', 'nri');
  assert.ok(r1.json.token, 'signed up');
  assert.equal(r1.json.created, true, 'first signup flagged as created');
  const st1 = (await call('GET', '/state', { token: r1.json.token })).json;
  assert.equal(st1.me.accountType, 'nri');
  assert.deepEqual(st1.me.location, {});
  const uid = st1.me.id;
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE email='phasea.nri@example.com'").get().c, 1);

  /* duplicate email + wrong password → clear error, still exactly one row */
  const dup = await call('POST', '/auth/email', { body: { email: 'phasea.nri@example.com', password: 'wrongpass1' } });
  assert.equal(dup.status, 401);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE email='phasea.nri@example.com'").get().c, 1);

  /* the same email logs into the same account; login never rewrites the type */
  const r2 = await signup('phasea.nri@example.com', 'normal');
  assert.equal(r2.json.created, false, 'existing email logs in');
  const st2 = (await call('GET', '/state', { token: r2.json.token })).json;
  assert.equal(st2.me.id, uid, 'same account id');
  assert.equal(st2.me.accountType, 'nri', 'existing account type kept');

  /* invalid account type is rejected before anything is created */
  const bad1 = await call('POST', '/auth/email', { body: { email: 'phasea.bad@example.com', password: 'secret123', name: 'X', accountType: 'vip' } });
  assert.equal(bad1.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE email='phasea.bad@example.com'").get().c, 0);
});

test('OTP registration carries the chosen account type; repeat verify is a login', async () => {
  const mobile = '9812300470';
  await call('POST', '/auth/otp/send', { body: { mobile } });
  const v = await call('POST', '/auth/otp/verify', { body: { mobile, otp: '123456', name: 'NRI OTP Probe', accountType: 'nri' } });
  assert.equal(v.status, 200);
  assert.equal(v.json.created, true);
  const st = (await call('GET', '/state', { token: v.json.token })).json;
  assert.equal(st.me.accountType, 'nri');

  await call('POST', '/auth/otp/send', { body: { mobile } });
  const v2 = await call('POST', '/auth/otp/verify', { body: { mobile, otp: '123456' } });
  assert.equal(v2.json.created, false, 'second verify logs in');
  const st2 = (await call('GET', '/state', { token: v2.json.token })).json;
  assert.equal(st2.me.id, st.me.id, 'same account');
});

test('account-type switch preserves bookings, addresses and family, and is audited', async () => {
  const r = await signup('phasea.switch@example.com', 'normal');
  const token = r.json.token;
  const b = (await call('POST', '/bookings', { token, body: bookingBody() })).json.booking;
  assert.ok(b && b.id, 'booking created');
  const fam = await call('POST', '/me/family', { token, body: { relationship: 'Mother', name: 'Probe Mother' } });
  assert.equal(fam.status, 201);
  const addr = await call('POST', '/me/addresses', { token, body: { l: 'Home', line: '5 Probe Lane', city: 'Delhi NCR', pin: '110001' } });
  assert.equal(addr.status, 200);

  const sw = await call('PATCH', '/me', { token, body: { accountType: 'nri' } });
  assert.equal(sw.status, 200);
  assert.equal(sw.json.accountType, 'nri');
  const st = (await call('GET', '/state', { token })).json;
  assert.equal(st.me.accountType, 'nri');
  assert.ok(st.bookings.some((x) => x.id === b.id), 'booking preserved');
  assert.equal(st.family.length, 1, 'family member preserved');
  assert.equal(st.me.addr.length, 1, 'address preserved');
  const audit = db.prepare("SELECT * FROM audit_logs WHERE action='user.account_type_switch' AND entity_id=?").get(st.me.id);
  assert.ok(audit, 'switch audited');
  assert.equal(audit.old_value, '"normal"');
  assert.equal(audit.new_value, '"nri"');

  /* admin sees the type on the same account */
  const at = await admin();
  const adminUsers = (await call('GET', '/state', { token: at })).json.users;
  assert.equal(adminUsers.find((u) => u.id === st.me.id).accountType, 'nri');

  const back = await call('PATCH', '/me', { token, body: { accountType: 'normal' } });
  assert.equal(back.json.accountType, 'normal');
  assert.equal((await call('PATCH', '/me', { token, body: { accountType: 'vip' } })).status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE email='phasea.switch@example.com'").get().c, 1, 'still exactly one account');
});

test('location capture: auto and manual saves, validation, audit and clear', async () => {
  const r = await signup('phasea.loc@example.com', 'normal');
  const token = r.json.token;
  const auto = await call('PATCH', '/me', { token, body: { location: { city: 'London', country: 'United Kingdom', lat: 51.5074, lon: -0.1278, source: 'auto', consentAt: Date.now() } } });
  assert.equal(auto.status, 200);
  assert.equal(auto.json.location.source, 'auto');
  let st = (await call('GET', '/state', { token })).json;
  assert.equal(st.me.location.city, 'London');
  assert.equal(st.me.location.country, 'United Kingdom');
  assert.equal(st.me.location.lat, 51.5074);
  assert.ok(st.me.location.consentAt > 0, 'consent timestamp stored');

  /* manual update carries no coordinates unless the user shared them */
  const man = await call('PATCH', '/me', { token, body: { location: { city: 'Dubai', country: 'UAE', source: 'manual' } } });
  assert.equal(man.json.location.lat, null);
  st = (await call('GET', '/state', { token })).json;
  assert.equal(st.me.location.city, 'Dubai');
  assert.equal(st.me.location.source, 'manual');
  assert.ok(db.prepare("SELECT id FROM audit_logs WHERE action='user.location_update' AND entity_id=?").get(st.me.id), 'location updates audited');

  /* junk is rejected with a clear error */
  assert.equal((await call('PATCH', '/me', { token, body: { location: { city: 'X', lat: 999, lon: 0, source: 'auto' } } })).status, 400);
  assert.equal((await call('PATCH', '/me', { token, body: { location: { city: 'X', source: 'gps' } } })).status, 400);

  /* clearing removes it entirely */
  await call('PATCH', '/me', { token, body: { location: {} } });
  st = (await call('GET', '/state', { token })).json;
  assert.deepEqual(st.me.location, {});

  /* access: location and type changes are customer-self only */
  assert.equal((await call('PATCH', '/me', { body: { accountType: 'nri' } })).status, 401);
});
