/* Phases 9-10: typed `transactions` ledger + effective-dated commission tiers.
   Harness parity with tests/qa.test.js — real app, fresh SQLite DB per run. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-ledger-'));
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

const payBooking = (token, id, body) => call('POST', '/payments/verify', { token, body: { bookingId: id, ...(body || { razorpay_order_id: 'o_' + id, razorpay_payment_id: 'p_' + id, razorpay_signature: 'sig_' + id }) } });
const ledgerRows = async (at, type) => (await call('GET', '/admin/ledger' + (type ? '?type=' + type : ''), { token: at })).json.entries;

/* Book -> pay -> complete -> payout PENDING -> process -> disburse. */
async function payoutLifecycle(at, ct, day) {
  const c = await call('POST', '/bookings', { token: ct, body: bookingBody({ date: dayPlus(day) }) });
  assert.equal(c.status, 201, 'booking created: ' + JSON.stringify(c.json));
  const b = c.json.booking || c.json;
  const pv = await payBooking(ct, b.id);
  assert.equal(pv.status, 200, 'payment verified');
  assert.equal((await call('POST', '/admin/bookings/' + b.id + '/status', { token: at, body: { status: 'Completed' } })).status, 200);
  const { db: DB, tx: TX } = require('../server/db');
  const poId = TX(() => DB.prepare('SELECT id FROM payouts WHERE booking_id=? ORDER BY id DESC').get(b.id).id)();
  assert.equal((await call('POST', '/admin/payouts/' + poId + '/process', { token: at, body: {} })).status, 200);
  const d = await call('POST', '/admin/payouts/' + poId + '/disburse', { token: at, body: { utr: 'UTR' + poId.slice(-6) } });
  assert.equal(d.status, 200);
  const net = d.json.payout.amt;
  return { booking: b, payoutId: poId, net };
}

test('ledger service: record validation, dedupe idempotency, totals sign split', async () => {
  const LEDGER = require('../server/services/ledger');
  assert.throws(() => LEDGER.record({ type: 'NOPE', amount: 100 }), /Unknown ledger type/);
  assert.throws(() => LEDGER.record({ type: 'DAKSHINA', amount: 0 }), /non-zero/);

  const a = LEDGER.record({ type: 'DAKSHINA', amount: 501, panditId: 'p1', refTable: 'x', refId: 'r1' });
  assert.ok(a.id);
  const b = LEDGER.record({ type: 'DAKSHINA', amount: 501, panditId: 'p1', refTable: 'x', refId: 'r1' });
  assert.notEqual(b.id, a.id, 'record is the raw primitive — duplicates allowed');
  const d1 = LEDGER.dedupe({ type: 'DAKSHINA', amount: 501, panditId: 'p1', refTable: 'x', refId: 'r1' });
  assert.equal(d1.deduped, true, 'same (type,ref) dedupes');
  const d2 = LEDGER.dedupe({ type: 'DAKSHINA', amount: 999, panditId: 'p1', refTable: 'x', refId: 'r1' });
  assert.equal(d2.deduped, true, 'amount is ignored when the ref already exists');

  const t = LEDGER.totals();
  assert.equal(t.DAKSHINA.total, 1002, '501+501 exactly once each');
  assert.equal(t.DAKSHINA.count, 2);
  assert.ok(t._inflow >= 1002, 'DAKSHINA counts as inflow');
});

test('tier resolver: window coverage, exact category before ALL, newest effective_from', async () => {
  const LEDGER = require('../server/services/ledger');
  LEDGER.tierCreate(null, { tier: 'GOLD', serviceCategory: 'ALL', commissionPct: 15, panditSharePct: 85, effectiveFrom: '2026-01-01' });
  const s = LEDGER.tierCreate(null, { tier: 'SILVER', serviceCategory: 'rudra', commissionPct: 25, effectiveFrom: '2026-02-01' });
  LEDGER.tierCreate(null, { tier: 'LEGACY', serviceCategory: 'ALL', commissionPct: 30, effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31' });
  LEDGER.tierCreate(null, { tier: 'PAUSED', serviceCategory: 'ALL', commissionPct: 50, effectiveFrom: '2026-01-01', active: false });

  assert.equal(LEDGER.resolveTier('p1', 'rudra', '2026-03-01').tier, 'SILVER', 'exact category wins over ALL');
  assert.equal(LEDGER.resolveTier('p1', 'ganesh', '2026-03-01').tier, 'GOLD', 'ALL is the catch-all');
  assert.equal(LEDGER.resolveTier('p1', 'ganesh', '2024-06-15'), null, 'before every window = null');
  LEDGER.tierCreate(null, { tier: 'PLATINUM', serviceCategory: 'ALL', commissionPct: 10, effectiveFrom: '2026-03-01' });
  assert.equal(LEDGER.resolveTier('p1', 'ganesh', '2026-04-01').tier, 'PLATINUM', 'newest effective_from wins');
  assert.equal(LEDGER.resolveTier('p1', 'ganesh', '2026-02-01').tier, 'GOLD', 'before the newer tier starts, GOLD applies');
  /* commissionPct hook: tier wins, settings fallback otherwise (no tier active today) */
  assert.deepEqual(LEDGER.commissionPct({ panditId: 'p1', serviceCategory: 'rudra' }), { pct: 25, tier: 'SILVER', tierId: s.id });
  for (const t0 of LEDGER.tierList()) if (t0.active) LEDGER.tierUpdate(null, t0.id, { active: false });
  const fb = LEDGER.commissionPct({ panditId: 'p1', serviceCategory: 'ganesh' });
  assert.equal(fb.tier, null, 'fallback has no tier');
  assert.equal(typeof fb.pct, 'number');
});

test('tier CRUD validation + audit actions', async () => {
  const at = await admin();
  assert.equal((await call('POST', '/admin/commission-tiers', { token: at, body: { commissionPct: 20 } })).status, 400, 'tier name required');
  assert.equal((await call('POST', '/admin/commission-tiers', { token: at, body: { tier: 'X', commissionPct: 91 } })).status, 400, 'pct > 90 refused');
  assert.equal((await call('POST', '/admin/commission-tiers', { token: at, body: { tier: 'X', commissionPct: 60, panditSharePct: 50 } })).status, 400, 'pct+share > 100 refused');
  const ok = await call('POST', '/admin/commission-tiers', { token: at, body: { tier: 'BRONZE', serviceCategory: 'satyanarayan', commissionPct: 20, panditSharePct: 80 } });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.tier.commissionPct, 20);
  const upd = await call('PATCH', '/admin/commission-tiers/' + ok.json.tier.id, { token: at, body: { commissionPct: 18 } });
  assert.equal(upd.json.tier.commissionPct, 18);
  assert.equal((await call('PATCH', '/admin/commission-tiers/99999', { token: at, body: { commissionPct: 10 } })).status, 400, 'unknown tier');
  const cust = await login('customer');
  assert.equal((await call('GET', '/admin/commission-tiers', { token: cust })).status, 403, 'customers cannot read tiers');
  const audits = (await call('GET', '/admin/audit?limit=300', { token: at })).json.entries;
  assert.ok(audits.some((a) => a.action === 'commission.tier_created'));
  assert.ok(audits.some((a) => a.action === 'commission.tier_updated'));
});

test('payments write ledger: SERVICE_PAYMENT on confirm, dedupe on retry, REFUND on cancel', async () => {
  const at = await admin(), ct = await login('customer');
  const c = await call('POST', '/bookings', { token: ct, body: bookingBody({ date: dayPlus(120) }) });
  assert.equal(c.status, 201);
  const b = c.json.booking || c.json;
  assert.equal((await payBooking(ct, b.id)).status, 200);
  const sp = await ledgerRows(at, 'SERVICE_PAYMENT');
  const mine = sp.find((r) => r.bookingId === b.id);
  assert.ok(mine, 'SERVICE_PAYMENT row for the booking');
  assert.equal(mine.amount, b.q.total, 'row amount equals booking total');
  const before = sp.length;
  await payBooking(ct, b.id, { razorpay_order_id: 'o_retry', razorpay_payment_id: 'p_retry', razorpay_signature: 'sig_retry' });
  assert.equal((await ledgerRows(at, 'SERVICE_PAYMENT')).length, before, 'payment retry does not double-count');

  const cancel = await call('POST', '/bookings/' + b.id + '/cancel', { token: ct, body: {} });
  assert.equal(cancel.status, 200, 'customer cancel ok');
  const rf = (await ledgerRows(at, 'REFUND')).find((r) => r.bookingId === b.id);
  assert.ok(rf, 'REFUND row on cancellation');
  assert.ok(rf.amount < 0, 'refund is signed negative');
});

test('payout lifecycle writes DAKSHINA + COMMISSION + PAYOUT; tier overrides the pct; settings fallback after deactivate', async () => {
  const at = await admin(), ct = await login('customer');
  /* clean slate: deactivate any tiers earlier tests left active, then lock an
     exact-category tier so the commission pct is deterministic */
  const LEDGER = require('../server/services/ledger');
  for (const t0 of LEDGER.tierList()) if (t0.active) LEDGER.tierUpdate(null, t0.id, { active: false });
  const t = (await call('POST', '/admin/commission-tiers', { token: at, body: { tier: 'LIFE', serviceCategory: 'Prosperity', commissionPct: 30, effectiveFrom: '2026-01-01' } })).json.tier;

  const { booking, payoutId, net } = await payoutLifecycle(at, ct, 130);
  const all = await ledgerRows(at);
  const dsh = all.find((r) => r.type === 'DAKSHINA' && r.bookingId === booking.id);
  assert.ok(dsh, 'DAKSHINA row exists at payout creation');
  assert.equal(dsh.amount, net, 'DAKSHINA equals the pandit share');
  const com = all.find((r) => r.type === 'COMMISSION' && r.refId === payoutId + ':commission');
  assert.ok(com && com.amount > 0, 'COMMISSION realized on disburse');
  const po = all.find((r) => r.type === 'PAYOUT' && r.refId === payoutId + ':payout');
  assert.ok(po && po.amount < 0 && po.amount === -net, 'PAYOUT mirrors the share, signed negative');
  assert.equal(com.amount, Math.round(booking.q.svc * 30 / 100), 'tier commission pct (30%) applied to the service fee, not the settings fallback');

  /* deactivate the tier and pin the settings pct: the next payout uses the fallback */
  assert.equal((await call('PATCH', '/admin/commission-tiers/' + t.id, { token: at, body: { active: false } })).status, 200);
  assert.equal((await call('POST', '/admin/settings', { token: at, body: { commission: 25 } })).status, 200);
  const { booking: b2, payoutId: po2, net: net2 } = await payoutLifecycle(at, ct, 131);
  const all2 = await ledgerRows(at);
  const com2 = all2.find((r) => r.type === 'COMMISSION' && r.refId === po2 + ':commission');
  assert.ok(com2, 'second lifecycle also realizes commission');
  assert.equal(com2.amount, Math.round(b2.q.svc * 25 / 100), 'settings fallback pct (25%) applied without a tier');
  assert.equal(net2, b2.q.svc - com2.amount, 'net = service fee - commission under fallback');
});

test('kundali payments: mock-generate and pay/verify both write KUNDALI_PAYMENT once', async () => {
  const at = await admin();
  await call('POST', '/auth/otp/send', { body: { mobile: '9811100999' } });
  const tc = (await call('POST', '/auth/otp/verify', { body: { mobile: '9811100999', otp: '123456' } })).json.token;
  const places = (await call('GET', '/kundali/places?q=Delhi', { token: tc })).json;
  const p0 = (places.places || places)[0];
  /* personal kundali within quota = FREE; a family member one is chargeable and settles PAID in mock mode */
  const fm = await call('POST', '/me/family', { token: tc, body: { relationship: 'Mother', name: 'Ledger Devi', dob: '1965-07-04', tob: '05:30', gender: 'female', city: 'Delhi', state: 'Delhi', country: 'India', lat: 28.6139, lon: 77.209, tz: 'Asia/Kolkata' } });
  assert.equal(fm.status, 201, 'family member created');
  const k = await call('POST', '/kundali/generate', { token: tc, body: { familyMemberId: fm.json.id, placeId: p0.id } });
  assert.equal(k.status, 201, 'family kundali generated');
  assert.equal(k.json.billing.state, 'PAID', 'mock gateway settles immediately');
  const row = (await ledgerRows(at, 'KUNDALI_PAYMENT')).find((r) => r.kundaliId === k.json.kundaliId);
  assert.ok(row, 'mock-paid kundali writes KUNDALI_PAYMENT at generate');
  assert.ok(row.amount > 0);
  /* re-verify must not duplicate the ledger row */
  await call('POST', '/kundali/pay/verify', { token: tc, body: { kundaliId: k.json.kundaliId } });
  assert.equal((await ledgerRows(at, 'KUNDALI_PAYMENT')).filter((r) => r.kundaliId === k.json.kundaliId).length, 1, 'verify replay does not double-count');
});

test('admin ledger API + Dakshina and Transactions xlsx reports', async () => {
  const at = await admin();
  const lv = (await call('GET', '/admin/ledger?limit=50', { token: at })).json;
  assert.ok(Array.isArray(lv.entries) && lv.entries.length > 0, 'entries listed');
  assert.ok(lv.totals && typeof lv.totals._inflow === 'number', 'totals returned with inflow split');
  const tiers = (await call('GET', '/admin/commission-tiers', { token: at })).json.tiers;
  assert.ok(Array.isArray(tiers) && tiers.length > 0, 'tier list served');

  /* xlsx export: dakshina lists DAKSHINA (positive) and PAYOUT (negative) entries.
     Layout: rows 1-3 banner, row 4 headers, rows 5+ data (maybe a Total row). */
  const get = async (rep, qs = '') => Buffer.from(await (await fetch(base + '/api/admin/export/' + rep + '.xlsx' + qs, { headers: { Authorization: 'Bearer ' + at } })).arrayBuffer());
  const rowsOf = async (buf) => { const wb = new (require('exceljs').Workbook)(); await wb.xlsx.load(buf); const ws = wb.worksheets[0]; const out = []; for (let i = 5; i <= ws.rowCount; i++) { const r = ws.getRow(i); if (r && r.values && r.values.length > 1) out.push(r.values); } return out; };
  const dataRows = await rowsOf(await get('dakshina'));
  assert.ok(dataRows.length > 0, 'dakshina report has rows');
  assert.ok(dataRows.some((r) => r[2] === 'p1' && r[5] === 'DAKSHINA' && Number(r[6]) > 0), 'a positive DAKSHINA entry for p1');
  assert.ok(dataRows.some((r) => r[2] === 'p1' && r[5] === 'PAYOUT' && Number(r[6]) < 0), 'a negative PAYOUT entry for p1');

  const txRows = await rowsOf(await get('transactions', '?type=PAYOUT'));
  assert.ok(txRows.length > 0 && txRows.every((r) => r[2] === 'PAYOUT'), 'transactions type filter works');

  const cust = await login('customer');
  assert.ok([401, 403].includes((await call('GET', '/admin/export/dakshina.xlsx', { token: cust })).status), 'reports are admin-only');
});
