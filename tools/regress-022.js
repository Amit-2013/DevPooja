#!/usr/bin/env node
/* Regression probe: migration 022 (coupon scope + redemptions) upgrade paths.

   Two modes, each run in a CHILD process so server/db.js picks up the right
   DB_PATH before anything is required:

     fresh   empty database -> bootstrap() applies 001..023 + seeds. Verifies
             the coupon layer comes up correct on a brand-new install (columns,
             seeded scope backfill, coupon_redemptions, quote + export smoke).

     legacy  builds a REALISTIC pre-012 install: the pre-008 base schema with
             migrations 001..011 actually applied (so kundalis already carry the
             008 commercial columns while 022's columns are still pending), then
             legacy data quirks are inserted (pre-022 coupons incl. an empty
             code, a pre-022 cart order, kundalis with PENDING_PAYMENT / USD
             gateway / mock payment rows, a paid booking with a coupon in `q`).
             Boot then applies 012..023 and the probe verifies the 022 upgrade
             preserved every legacy row and that live coupon flows still work.

   Usage:
     node tools/regress-022.js            runs both modes, aggregates exit codes
     node tools/regress-022.js fresh      one mode only
     node tools/regress-022.js legacy     one mode only

   Ops-style probe over synthetic databases only; no test-runner coupling. */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const MODES = ['fresh', 'legacy'];

if (require.main === module && MODES.includes(process.argv[2])) {
  runMode(process.argv[2]).then((code) => process.exit(code));
} else {
  /* parent: spawn each mode in its own process */
  let failures = 0;
  for (const mode of (process.argv[2] ? [process.argv[2]] : MODES)) {
    if (!MODES.includes(mode)) { console.error('Unknown mode: ' + mode); process.exit(2); }
    console.log('\n=== regression-022 [' + mode + '] ===');
    const r = spawnSync(process.execPath, [__filename, mode], { stdio: 'inherit' });
    if (r.status !== 0) failures++;
  }
  console.log(failures ? '\nRESULT: FAIL (' + failures + ' mode(s))' : '\nRESULT: PASS (all modes)');
  process.exit(failures ? 1 : 0);
}

async function runMode(mode) {
  const os = require('os'), fs = require('fs');
  const assert = require('node:assert/strict');
  const ROOT = path.join(__dirname, '..');
  const MIGRATIONS = path.join(ROOT, 'server', 'migrations');
  const allMigrations = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  const HOLD = '012_audit_payout_foundation.sql';
  const through011 = allMigrations.slice(0, allMigrations.indexOf(HOLD));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-022-' + mode + '-'));
  process.env.NODE_ENV = 'test';
  process.env.DEMO_MODE = 'true';
  process.env.QUIET = '1';
  process.env.JWT_SECRET = 'test-secret';
  process.env.DB_PATH = path.join(dir, mode + '.db');
  process.env.UPLOAD_DIR = path.join(dir, 'uploads');

  let failures = 0;
  const check = (name, fn) => {
    try { fn(); console.log('PASS ' + name); }
    catch (e) { failures++; console.error('FAIL ' + name + ' :: ' + e.message); }
  };
  const Database = require('better-sqlite3');
  const hasCol = (db, t, c) => !!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name=?').get(t, c);
  const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

  /* ---------- build the database for this mode ---------- */
  const raw = new Database(process.env.DB_PATH);
  raw.pragma('journal_mode = WAL');
  if (mode === 'legacy') {
    /* The pre-008 base schema (exactly the db.js exec block of that era).
       kundalis is NOT here: it arrives with migrations 002/003. */
    raw.exec(`
CREATE TABLE users(id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'customer', name TEXT, mobile TEXT UNIQUE, email TEXT UNIQUE, pass_hash TEXT,
  pts INTEGER NOT NULL DEFAULT 0, plus INTEGER NOT NULL DEFAULT 0, pref TEXT NOT NULL DEFAULT '{}', addr TEXT NOT NULL DEFAULT '[]',
  fam TEXT NOT NULL DEFAULT '[]', joined TEXT, created_at INTEGER);
CREATE TABLE pandits(id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, city TEXT, exp INTEGER DEFAULT 0, langs TEXT DEFAULT '[]', spec TEXT DEFAULT '[]',
  rating REAL DEFAULT 0, rev INTEGER DEFAULT 0, done INTEGER DEFAULT 0, pf REAL DEFAULT 1, bio TEXT, color TEXT, status TEXT DEFAULT 'pending',
  featured INTEGER DEFAULT 0, off TEXT DEFAULT '[]', mobile TEXT UNIQUE, avail INTEGER DEFAULT 1, kyc TEXT DEFAULT '{}');
CREATE TABLE pujas(id TEXT PRIMARY KEY, name TEXT NOT NULL, hindi TEXT, cat TEXT, icon TEXT, dur INTEGER, price INTEGER NOT NULL, deity TEXT, ben TEXT,
  kit TEXT, pop INTEGER DEFAULT 0, tags TEXT DEFAULT '', hidden INTEGER DEFAULT 0);
CREATE TABLE kits(id TEXT PRIMARY KEY, name TEXT, price INTEGER, icon TEXT, items TEXT, stock INTEGER DEFAULT 0);
CREATE TABLE prasad(id TEXT PRIMARY KEY, name TEXT, price INTEGER, icon TEXT, descr TEXT, stock INTEGER, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE temples(id TEXT PRIMARY KEY, name TEXT, city TEXT, deity TEXT, icon TEXT, pujas TEXT, offering INTEGER, descr TEXT);
CREATE TABLE festivals(id TEXT PRIMARY KEY, name TEXT, date TEXT, pujas TEXT, note TEXT);
CREATE TABLE bookings(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, puja_id TEXT NOT NULL, mode TEXT NOT NULL, date TEXT NOT NULL, slot TEXT NOT NULL, addr TEXT,
  temple_id TEXT, pandit_id TEXT, pst TEXT, sam TEXT DEFAULT '[]', pra TEXT DEFAULT '[]', notes TEXT, member TEXT, coupon TEXT, q TEXT NOT NULL,
  status TEXT NOT NULL, pay TEXT NOT NULL, ops TEXT DEFAULT '{}', media TEXT DEFAULT '[]', review TEXT, created INTEGER, log TEXT DEFAULT '[]',
  refund TEXT, esc INTEGER DEFAULT 0, review_hidden INTEGER DEFAULT 0);
CREATE TABLE orders(id TEXT PRIMARY KEY, user_id TEXT, items TEXT, total INTEGER, date TEXT, status TEXT, city TEXT, address TEXT);
CREATE TABLE notifs(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, channel TEXT, message TEXT, ts INTEGER);
CREATE TABLE tickets(id TEXT PRIMARY KEY, user_id TEXT, booking_id TEXT, text TEXT, status TEXT, prio TEXT);
CREATE TABLE campaigns(id TEXT PRIMARY KEY, name TEXT, channel TEXT, audience TEXT, status TEXT, sent INTEGER DEFAULT 0);
CREATE TABLE leads(id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, name TEXT, details TEXT, date TEXT);
CREATE TABLE payouts(id TEXT PRIMARY KEY, pandit_id TEXT, amount INTEGER, date TEXT, status TEXT, booking_id TEXT);
CREATE TABLE coupons(code TEXT PRIMARY KEY, type TEXT, val INTEGER, max INTEGER, min INTEGER, active INTEGER DEFAULT 1, used INTEGER DEFAULT 0);
CREATE TABLE banners(id TEXT PRIMARY KEY, text TEXT, enabled INTEGER DEFAULT 1);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE otps(mobile TEXT PRIMARY KEY, code_hash TEXT, expires INTEGER, attempts INTEGER DEFAULT 0);
`);
    /* Apply 001..011 for real: this is what "pre-012" actually looks like —
       kundalis already has the 008 commercial columns, 022 columns pending. */
    raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
    for (const f of through011) {
      const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
      raw.transaction(() => {
        raw.exec(sql);
        raw.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run(f);
      })();
    }
    /* Legacy data quirks that must survive the upgrade. */
    raw.prepare("INSERT INTO users(id,role,name,mobile,email,created_at) VALUES('u1','customer','Legacy Owner','9811199990','legacy@example.com',?)").run(Date.now());
    raw.prepare("INSERT INTO users(id,role,name,mobile,joined,created_at) VALUES('pu1','pandit','Legacy Pandit','9810000099','2024-01-01',?)").run(Date.now());
    raw.prepare("INSERT INTO pandits(id,user_id,name,city,status,avail,pf) VALUES('p1','pu1','Legacy Pandit','Delhi NCR','verified',1,1.1)").run();
    raw.prepare("INSERT INTO pujas(id,name,price) VALUES('ganesh','Legacy Ganesha Puja',2000)").run();
    raw.prepare("INSERT INTO kits(id,name,price,items,stock) VALUES('k_basic','Legacy Kit',1600,'[]',40)").run();
    raw.prepare("INSERT INTO coupons(code,type,val,max,min,active,used) VALUES('LEGACY10','pct',10,500,1500,1,7)").run();
    raw.prepare("INSERT INTO coupons(code,type,val,max,min,active,used) VALUES('LEGACY50','flat',50,50,1000,1,2)").run();
    raw.prepare("INSERT INTO coupons(code,type,val,max,min,active,used) VALUES('','pct',5,100,0,1,0)").run(); /* legacy empty code */
    raw.prepare("INSERT INTO kundalis(id,name,customer_id,family_member_id,relationship,billing,price,discount,gst,final_amount,currency,order_id,payment_status,payment_id,idem_key,created_at) VALUES('KLEGACYAA0001','Legacy Pending','u1','','','PENDING_PAYMENT',499,0,25,524,'INR','KDOLEG1','Pending','','idem-legacy-pend1',?)").run(Date.now());
    raw.prepare("INSERT INTO kundalis(id,name,customer_id,family_member_id,relationship,billing,price,discount,gst,final_amount,currency,order_id,payment_status,payment_id,idem_key,created_at) VALUES('KLEGACYAA0002','Legacy USD Gateway','u1','','','PAID',499,0,25,524,'USD','KDOLEG2','Paid','pay_USDGW1','idem-legacy-gw2',?)").run(Date.now());
    raw.prepare("INSERT INTO kundalis(id,name,customer_id,family_member_id,relationship,billing,price,discount,gst,final_amount,currency,order_id,payment_status,payment_id,idem_key,created_at) VALUES('KLEGACYAA0003','Legacy Mock','u1','','','PAID',499,0,25,524,'INR','KDOLEG3','Paid','MOCKAB12','idem-legacy-mock3',?)").run(Date.now());
    raw.prepare("INSERT INTO bookings(id,user_id,puja_id,mode,date,slot,member,coupon,q,status,pay,created) VALUES('DPLEGACY1','u1','ganesh','home',date('now','+5 day'),'10:00 AM','Self','LEGACY10',?,'Confirmed',?,?)")
      .run(JSON.stringify({ svc: 2200, disc: 220, gst: 396, total: 2596 }), JSON.stringify({ method: 'UPI', ref: 'UPL1', paid: true }), Date.now());
    raw.prepare("INSERT INTO orders(id,user_id,items,total,date,status,city,address) VALUES('ORLEGACY1','u1',?,1649,date('now','-1 day'),'Delivered','Delhi NCR','1 Legacy Lane')")
      .run(JSON.stringify([{ k: 'k_basic', q: 1 }]));
    /* Pre-boot snapshot assertions: this really is a pre-022 database. */
    check('legacy build: pre-boot db is genuinely pre-022', () => {
      assert.ok(!hasCol(raw, 'coupons', 'scope') && !hasCol(raw, 'orders', 'coupon') && !hasCol(raw, 'kundalis', 'coupon'), 'no 022 columns yet');
      assert.ok(!hasTable(raw, 'coupon_redemptions'), 'no coupon_redemptions yet');
      assert.ok(hasCol(raw, 'kundalis', 'customer_id') && hasCol(raw, 'kundalis', 'payment_id'), '008 commercial columns present');
      const done = raw.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name);
      assert.equal(done.length, through011.length, 'schema_migrations pins exactly 001..011');
    });
  }
  raw.close();

  /* ---------- boot the real server over this database ---------- */
  const seedMod = require(path.join(ROOT, 'server', 'seed.js'));
  const app = require(path.join(ROOT, 'server', 'index.js'));
  const { db } = require(path.join(ROOT, 'server', 'db.js'));
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  await seedMod.settledMedia();
  const call = async (method, url, { token, body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetch(base + '/api' + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const admin = (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
  const ct = (await call('POST', '/auth/demo', { body: { role: 'customer' } })).json.token;
  check('boot: server up on the ' + mode + ' database', () => assert.ok(base && admin && ct, 'tokens issued'));

  const applied = db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name);
  check('boot: every migration up to the newest applied', () => {
    for (const f of allMigrations) assert.ok(applied.includes(f), f + ' applied');
  });
  check('schema: coupon layer present (columns + redemptions table)', () => {
    for (const c of ['scope', 'puja_id', 'starts', 'expires', 'per_user']) assert.ok(hasCol(db, 'coupons', c), 'coupons.' + c);
    for (const c of ['coupon', 'discount']) assert.ok(hasCol(db, 'orders', c), 'orders.' + c);
    assert.ok(hasCol(db, 'kundalis', 'coupon'), 'kundalis.coupon');
    assert.ok(hasTable(db, 'coupon_redemptions'), 'coupon_redemptions table');
  });

  if (mode === 'fresh') {
    check('fresh: seeded coupons backfilled to ALL with neutral caps', () => {
      const rows = db.prepare('SELECT * FROM coupons ORDER BY code').all();
      assert.ok(rows.length >= 3, 'seeded coupons exist');
      for (const r of rows) { assert.equal(r.scope, 'ALL', r.code); assert.equal(r.per_user, 0, r.code); }
    });
    const q = await call('POST', '/quote', { token: ct, body: { pujaId: 'satyanarayan', mode: 'home', sam: [], pra: [], coupon: 'FIRST100' } });
    check('fresh: quote endpoint validates a seeded coupon', () => {
      assert.equal(q.status, 200, JSON.stringify(q.json));
      assert.equal(q.json.couponError, '', 'FIRST100 accepted on an eligible booking');
    });
  } else {
    check('legacy upgrade: coupon rows preserved + backfilled to ALL', () => {
      const rows = db.prepare("SELECT * FROM coupons WHERE code IN ('LEGACY10','LEGACY50') ORDER BY code").all();
      assert.equal(rows.length, 2, 'both legacy codes survive');
      for (const r of rows) {
        assert.equal(r.scope, 'ALL', r.code + ' backfilled');
        assert.equal(r.per_user, 0, r.code + ' per_user default');
        assert.equal(r.active, 1, r.code + ' still active');
        assert.ok(r.used >= 2, r.code + ' usage counter preserved');
      }
      assert.ok(db.prepare("SELECT 1 FROM coupons WHERE code=''").get(), 'legacy empty-code row survives');
    });
    check('legacy upgrade: kundali rows preserved byte-for-byte', () => {
      assert.equal(db.prepare('SELECT currency FROM kundalis WHERE id=?').get('KLEGACYAA0002').currency, 'USD', 'gateway currency');
      assert.equal(db.prepare('SELECT payment_id FROM kundalis WHERE id=?').get('KLEGACYAA0002').payment_id, 'pay_USDGW1', 'gateway payment id');
      assert.equal(db.prepare('SELECT billing FROM kundalis WHERE id=?').get('KLEGACYAA0001').billing, 'PENDING_PAYMENT', 'pending state preserved');
      assert.equal(db.prepare('SELECT payment_id FROM kundalis WHERE id=?').get('KLEGACYAA0003').payment_id, 'MOCKAB12', 'mock payment id');
      assert.equal(db.prepare('SELECT coupon FROM kundalis WHERE id=?').get('KLEGACYAA0003').coupon, '', '022 coupon column defaulted empty');
    });
    check('legacy upgrade: pre-022 cart order upgraded with neutral defaults', () => {
      const o = db.prepare('SELECT * FROM orders WHERE id=?').get('ORLEGACY1');
      assert.equal(o.coupon, '', 'coupon default empty');
      assert.equal(o.discount, 0, 'discount default 0');
      assert.equal(o.total, 1649, 'total untouched');
    });
    check('legacy upgrade: paid legacy booking and its coupon survive', () => {
      const b = db.prepare('SELECT * FROM bookings WHERE id=?').get('DPLEGACY1');
      assert.equal(b.coupon, 'LEGACY10');
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_pandit_slot'").get(), 'booking indexes intact');
    });

    /* Live smoke on the upgraded database: the legacy customer redeems the
       legacy ALL-scope coupon on a NEW booking, and the cart path works. */
    const dayPlus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
    const bk = await call('POST', '/bookings', { token: ct, body: { pujaId: 'ganesh', mode: 'home', date: dayPlus(9), slot: '10:00 AM', addr: { line: '1 Legacy Lane', city: 'Delhi NCR', pin: '110016' }, panditId: 'p1', sam: [], pra: [], coupon: 'LEGACY10' } });
    check('legacy smoke: new booking with the upgraded legacy coupon accepted', () => {
      assert.equal(bk.status, 201, JSON.stringify(bk.json));
      assert.ok(bk.json.booking.q.disc > 0, 'discount applied');
    });
    check('legacy smoke: money-moment redemption recorded on the upgraded schema', () => {
      const row = db.prepare("SELECT * FROM coupon_redemptions WHERE source='booking' AND ref_id=?").get(bk.json.booking.id);
      assert.ok(row, 'redemption row exists');
      assert.equal(row.code, 'LEGACY10');
      assert.equal(row.user_id, 'u1', 'the legacy customer redeems');
      assert.ok(row.amount > 0, 'discount amount recorded');
    });
    const ord = await call('POST', '/orders', { token: ct, body: { items: [{ k: 'k_basic', q: 1 }], address: '1 Legacy Lane', city: 'Delhi NCR', coupon: 'LEGACY10' } });
    check('legacy smoke: cart order redeems the ALL-scope coupon', () => {
      assert.equal(ord.status, 201, JSON.stringify(ord.json));
      assert.equal(ord.json.order.coupon, 'LEGACY10');
      assert.ok(ord.json.order.discount > 0);
      const row = db.prepare("SELECT * FROM coupon_redemptions WHERE source='order' AND ref_id=?").get(ord.json.order.id);
      assert.ok(row, 'order redemption recorded');
    });
  }

  for (const rep of ['coupon-redemptions', 'coupon-usage']) {
    const r = await fetch(base + '/api/admin/export/' + rep + '.xlsx', { headers: { Authorization: 'Bearer ' + admin } });
    const buf = Buffer.from(await r.arrayBuffer());
    check('export: ' + rep + ' renders on the ' + mode + ' database', () => {
      assert.equal(r.status, 200);
      assert.ok(buf.length > 500 && buf.slice(0, 2).toString() === 'PK', 'real xlsx');
    });
  }

  console.log(failures ? 'MODE ' + mode + ': FAIL (' + failures + ')' : 'MODE ' + mode + ': PASS');
  server.closeAllConnections();
  server.close();
  process.exit(failures ? 1 : 0);
}
