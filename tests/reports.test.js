/* Phase 30 — Reports: the five registry additions (kyc, incidents, agreements,
   commission-tiers, nri-packages) on the Node side. Covers: the professional
   layout contract (title block, frozen ySplit:4 header, exact column headers per
   id, worksheet named after the id), each module's own list-view filters
   (kyc status + from/to ms-epoch day window, incidents status/category,
   agreements status, tiers/NRI active flag), the NRI `includes` JSON rendered as
   a readable comma list, the export_logs audit trail, and the Phase 21 access
   rule that all five are admin-export-only (finance/customer_support 403,
   customer 403, anonymous 401). Harness parity with tests/rbac.test.js. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-reports-'));
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
const adminLogin = async () => (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
/* An operations seat: OTP-created customer, role written straight to the DB —
   authenticate() re-reads the role per request, so the token acts at once. */
const seat = async (mobile, role) => {
  await call('POST', '/auth/otp/send', { body: { mobile } });
  const tok = (await call('POST', '/auth/otp/verify', { body: { mobile, otp: '123456', name: 'Report Probe' } })).json.token;
  const uid = db.prepare('SELECT id FROM users WHERE mobile=?').get(mobile).id;
  if (role !== 'customer') db.prepare('UPDATE users SET role=? WHERE id=?').run(role, uid);
  return { tok, uid };
};

/* Exact header contract: row 4 of each export (the frozen header row). */
const EXPECTED = {
  kyc: ['Document ID', 'Pandit ID', 'Pandit', 'Document type', 'File name', 'Status', 'Uploaded',
    'Verified by', 'Verified at', 'Reject reason', 'Expires at', 'Next re-verification'],
  incidents: ['Incident ID', 'Pandit ID', 'Pandit', 'Booking ID', 'Customer ID', 'Category',
    'Description', 'Status', 'Admin notes', 'Resolution', 'Reported', 'Resolved'],
  agreements: ['Agreement ID', 'Version', 'Title', 'Status', 'Document hash', 'File name',
    'Created by', 'Effective from', 'Created', 'Published', 'Archived', 'Acceptances'],
  'commission-tiers': ['Tier ID', 'Tier', 'Service category', 'Commission %', 'Pandit share %',
    'Effective from', 'Effective to', 'Active'],
  'nri-packages': ['Package ID', 'Name', 'Description', 'Price', 'Currency', 'INR equivalent',
    'Includes', 'Active', 'Created'],
};
const FIVE = Object.keys(EXPECTED);

/* Fetch one export and parse it: returns the worksheet plus its data rows
   (row 5 onward, with the bold totals row dropped). */
async function report(token, id, qs) {
  const r = await fetch(base + '/api/admin/export/' + id + '.xlsx' + (qs ? '?' + qs : ''),
    { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(r.status, 200, id + ' exports: ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK', id + ' is a real xlsx');
  const wb = new (require('exceljs').Workbook)();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const rows = [];
  for (let i = 5; i <= ws.rowCount; i++) {
    const vals = ws.getRow(i).values.slice(1);
    if (!vals.length || vals[0] == null || vals[0] === 'Total') continue;
    rows.push(vals);
  }
  return { ws, rows, headers: ws.getRow(4).values.slice(1) };
}
const col = (row, headers, name) => row[headers.indexOf(name)];

test('phase 30 layout contract: title block, frozen header, exact columns per id', async () => {
  const admin = await adminLogin();
  for (const id of FIVE) {
    const { ws, headers } = await report(admin, id);
    assert.equal(ws.name, id, 'worksheet is named after the report id');
    assert.match(String(ws.getCell(1, 1).value), /^DaivikPuja — /, id + ' title row');
    assert.match(String(ws.getCell(2, 1).value), /^Generated on: /, id + ' generated row');
    assert.match(String(ws.getCell(3, 1).value), /^Filters: /, id + ' filters row');
    assert.equal(ws.views[0].state, 'frozen', id + ' header stays frozen');
    assert.equal(ws.views[0].ySplit, 4, id + ' frozen below the 3-row title block');
    assert.deepEqual(headers, EXPECTED[id], id + ' column headers');
  }
  /* every download lands in the export audit log */
  const logs = (await call('GET', '/admin/export-logs', { token: admin })).json.logs;
  const seen = new Set(logs.map((l) => l.report));
  for (const id of FIVE) assert.ok(seen.has(id), id + ' export audited');
});

test('kyc report: status filter and from/to ms-epoch day window narrow the export', async () => {
  const admin = await adminLogin();
  const now = Date.now();
  const old = Date.parse('2020-03-15T10:00:00Z');
  db.prepare('INSERT INTO kyc_documents(id,pandit_id,doc_type,file_name,status,uploaded_at) VALUES(?,?,?,?,?,?)')
    .run('kycdrill1', 'p1', 'Aadhaar', 'a-front.png', 'PENDING', now);
  db.prepare('INSERT INTO kyc_documents(id,pandit_id,doc_type,file_name,status,uploaded_at) VALUES(?,?,?,?,?,?)')
    .run('kycdrill2', 'p1', 'PAN', 'pan-card.png', 'VERIFIED', old);

  const all = await report(admin, 'kyc');
  assert.deepEqual(all.rows.map((r) => r[0]).sort(), ['kycdrill1', 'kycdrill2'], 'both documents export');

  const pending = await report(admin, 'kyc', 'status=PENDING');
  assert.deepEqual(pending.rows.map((r) => r[0]), ['kycdrill1'], 'status narrows');
  assert.match(String(pending.ws.getCell(3, 1).value), /status: PENDING/, 'applied filters are printed');

  const recent = await report(admin, 'kyc', 'from=2021-01-01');
  assert.deepEqual(recent.rows.map((r) => r[0]), ['kycdrill1'], 'from excludes the 2020 upload');
  const window = await report(admin, 'kyc', 'to=2020-12-31');
  assert.deepEqual(window.rows.map((r) => r[0]), ['kycdrill2'], 'to keeps only the 2020 upload');
  assert.equal(col(window.rows[0], window.headers, 'Status'), 'VERIFIED', 'row content preserved through the filter');
});

test('incidents report: status and category filters narrow the export', async () => {
  const admin = await adminLogin();
  const now = Date.now();
  const old = Date.parse('2020-06-01T09:00:00Z');
  db.prepare(`INSERT INTO incidents(id,pandit_id,booking_id,customer_id,category,description,evidence,status,reported_at)
    VALUES(?,?,?,?,?,?,'[]',?,?)`)
    .run('INCDRILL1', 'p1', null, null, 'SAFETY_CONCERN', 'Stray dogs blocked the courtyard.', 'OPEN', now);
  db.prepare(`INSERT INTO incidents(id,pandit_id,booking_id,customer_id,category,description,evidence,status,reported_at)
    VALUES(?,?,?,?,?,?,'[]',?,?)`)
    .run('INCDRILL2', 'p1', null, null, 'OTHER', 'Balance payment refused on arrival.', 'UNDER_REVIEW', old);

  const all = await report(admin, 'incidents');
  assert.ok(all.rows.some((r) => r[0] === 'INCDRILL1') && all.rows.some((r) => r[0] === 'INCDRILL2'),
    'both incidents export');

  const open = await report(admin, 'incidents', 'status=OPEN');
  assert.deepEqual(open.rows.map((r) => r[0]), ['INCDRILL1'], 'status narrows');

  const other = await report(admin, 'incidents', 'category=OTHER');
  assert.deepEqual(other.rows.map((r) => r[0]), ['INCDRILL2'], 'category narrows');
  assert.equal(col(other.rows[0], other.headers, 'Status'), 'UNDER_REVIEW', 'row content preserved');

  const both = await report(admin, 'incidents', 'status=OPEN&category=OTHER');
  assert.deepEqual(both.rows, [], 'stacked filters combine');
  const from = await report(admin, 'incidents', 'from=2021-01-01');
  assert.deepEqual(from.rows.map((r) => r[0]), ['INCDRILL1'], 'from excludes the older report');
});

test('agreements report: acceptance counts and status filter', async () => {
  const admin = await adminLogin();
  const body1 = 'Pandit partner agreement v1. The pandit commits to the code of conduct.';
  const d = await call('POST', '/admin/agreements', { token: admin, body: { title: 'Report drill agreement', body: body1 } });
  assert.equal(d.status, 201, JSON.stringify(d.json));
  const id = d.json.agreement.id;
  assert.equal((await call('POST', '/admin/agreements/' + id + '/publish', { token: admin, body: {} })).status, 200);

  const now = Date.now();
  const acc = db.prepare(`INSERT INTO agreement_acceptances(id,agreement_id,pandit_id,method,otp_verified,accepted_at)
    VALUES(?,?,?,?,?,?)`);
  acc.run('acc_drill_1', id, 'p1', 'DIGITAL', 1, now);
  acc.run('acc_drill_2', id, 'p2', 'MANUAL', 0, now);

  const all = await report(admin, 'agreements');
  const row = all.rows.find((r) => r[0] === id);
  assert.ok(row, 'the published agreement exports');
  assert.equal(col(row, all.headers, 'Status'), 'PUBLISHED', 'status column');
  assert.equal(col(row, all.headers, 'Acceptances'), 2, 'acceptance count is a subquery, not a literal');
  assert.ok(String(col(row, all.headers, 'Document hash')).length === 64, 'sha256 hash carried through');

  const pub = await report(admin, 'agreements', 'status=PUBLISHED');
  assert.ok(pub.rows.some((r) => r[0] === id), 'status filter keeps it');
  const draft = await report(admin, 'agreements', 'status=DRAFT');
  assert.ok(!draft.rows.some((r) => r[0] === id), 'status filter drops it');
});

test('commission-tiers and nri-packages: active filter and includes parsing', async () => {
  const admin = await adminLogin();
  const ins = db.prepare(`INSERT INTO commission_tiers(tier,service_category,commission_pct,pandit_share_pct,effective_from,effective_to,active)
    VALUES(?,?,?,?,?,?,?)`);
  ins.run('DRILL ACTIVE', 'ALL', 15, 85, '2026-01-01', null, 1);
  ins.run('DRILL PAUSED', 'ALL', 50, 50, '2026-01-01', null, 0);

  const on = await report(admin, 'commission-tiers', 'active=1');
  assert.ok(on.rows.some((r) => r[1] === 'DRILL ACTIVE'), 'active tiers export');
  assert.ok(!on.rows.some((r) => r[1] === 'DRILL PAUSED'), 'active=1 drops paused tiers');
  const off = await report(admin, 'commission-tiers', 'active=0');
  assert.deepEqual(off.rows.map((r) => r[1]), ['DRILL PAUSED'], 'active=0 keeps only paused tiers');

  db.prepare('INSERT INTO nri_packages(id,name,descr,price,currency,inr_equiv,includes,active,created) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('nrp-drill', 'Drill package', 'Inactive probe', 99, 'USD', 8300, JSON.stringify(['Alpha seva', 'Beta prasad']), 0, Date.now());

  const pkgs = await report(admin, 'nri-packages', 'active=0');
  assert.deepEqual(pkgs.rows.map((r) => r[0]), ['nrp-drill'], 'active=0 isolates the inactive package');
  assert.equal(col(pkgs.rows[0], pkgs.headers, 'Includes'), 'Alpha seva, Beta prasad',
    'includes JSON renders as a readable comma list');

  const live = await report(admin, 'nri-packages', 'active=1');
  assert.ok(live.rows.length >= 3, 'the demo catalogue is active');
  assert.ok(!live.rows.some((r) => r[0] === 'nrp-drill'), 'active=1 drops the inactive package');
});

test('phase 30 access: the five reports stay admin-export-only', async () => {
  const anon = await fetch(base + '/api/admin/export/kyc.xlsx');
  assert.equal(anon.status, 401, 'anonymous is refused before the registry is consulted');

  const customer = await call('POST', '/auth/demo', { body: { role: 'customer' } });
  for (const id of FIVE) {
    const r = await fetch(base + '/api/admin/export/' + id + '.xlsx',
      { headers: { Authorization: 'Bearer ' + customer.json.token } });
    assert.equal(r.status, 403, id + ' is outside the admin family');
  }

  const finance = await seat('9811100301', 'finance');
  const support = await seat('9811100302', 'customer_support');
  for (const id of FIVE) {
    const f = await call('GET', '/admin/export/' + id + '.xlsx', { token: finance.tok });
    assert.equal(f.status, 403, id + ' is not a finance-domain report');
    assert.equal(f.json.error, 'Not allowed for your role');
    const s = await call('GET', '/admin/export/' + id + '.xlsx', { token: support.tok });
    assert.equal(s.status, 403, id + ' never exports for customer_support');
  }
  assert.equal((await call('GET', '/admin/export/payments.xlsx', { token: finance.tok })).status, 200,
    'finance still exports its own twelve');

  const admin = await adminLogin();
  for (const id of FIVE) assert.equal((await call('GET', '/admin/export/' + id + '.xlsx', { token: admin })).status, 200, id);
});
