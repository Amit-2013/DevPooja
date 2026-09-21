const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'deivikpooja.db');
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'customer', name TEXT, mobile TEXT UNIQUE, email TEXT UNIQUE, pass_hash TEXT,
  pts INTEGER NOT NULL DEFAULT 0, plus INTEGER NOT NULL DEFAULT 0, pref TEXT NOT NULL DEFAULT '{}', addr TEXT NOT NULL DEFAULT '[]',
  fam TEXT NOT NULL DEFAULT '[]', joined TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS pandits(
  id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, city TEXT, exp INTEGER DEFAULT 0, langs TEXT DEFAULT '[]', spec TEXT DEFAULT '[]',
  rating REAL DEFAULT 0, rev INTEGER DEFAULT 0, done INTEGER DEFAULT 0, pf REAL DEFAULT 1, bio TEXT, color TEXT, status TEXT DEFAULT 'pending',
  featured INTEGER DEFAULT 0, off TEXT DEFAULT '[]', mobile TEXT UNIQUE, avail INTEGER DEFAULT 1, kyc TEXT DEFAULT '{}');
CREATE TABLE IF NOT EXISTS pujas(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, hindi TEXT, cat TEXT, icon TEXT, dur INTEGER, price INTEGER NOT NULL, deity TEXT, ben TEXT,
  kit TEXT, pop INTEGER DEFAULT 0, tags TEXT DEFAULT '', hidden INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS kits(id TEXT PRIMARY KEY, name TEXT, price INTEGER, icon TEXT, items TEXT, stock INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS prasad(id TEXT PRIMARY KEY, name TEXT, price INTEGER, icon TEXT, descr TEXT);
CREATE TABLE IF NOT EXISTS temples(id TEXT PRIMARY KEY, name TEXT, city TEXT, deity TEXT, icon TEXT, pujas TEXT, offering INTEGER, descr TEXT);
CREATE TABLE IF NOT EXISTS festivals(id TEXT PRIMARY KEY, name TEXT, date TEXT, pujas TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS bookings(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, puja_id TEXT NOT NULL, mode TEXT NOT NULL, date TEXT NOT NULL, slot TEXT NOT NULL, addr TEXT,
  temple_id TEXT, pandit_id TEXT, pst TEXT, sam TEXT DEFAULT '[]', pra TEXT DEFAULT '[]', notes TEXT, member TEXT, coupon TEXT, q TEXT NOT NULL,
  status TEXT NOT NULL, pay TEXT NOT NULL, ops TEXT DEFAULT '{}', media TEXT DEFAULT '[]', review TEXT, created INTEGER, log TEXT DEFAULT '[]',
  refund TEXT, esc INTEGER DEFAULT 0, review_hidden INTEGER DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pandit_slot ON bookings(pandit_id, date, slot)
  WHERE pandit_id IS NOT NULL AND status NOT IN ('Cancelled');
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_pandit ON bookings(pandit_id);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, user_id TEXT, items TEXT, total INTEGER, date TEXT, status TEXT, city TEXT, address TEXT);
CREATE TABLE IF NOT EXISTS notifs(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, channel TEXT, message TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY, user_id TEXT, booking_id TEXT, text TEXT, status TEXT, prio TEXT);
CREATE TABLE IF NOT EXISTS campaigns(id TEXT PRIMARY KEY, name TEXT, channel TEXT, audience TEXT, status TEXT, sent INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS leads(id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, name TEXT, details TEXT, date TEXT);
CREATE TABLE IF NOT EXISTS payouts(id TEXT PRIMARY KEY, pandit_id TEXT, amount INTEGER, date TEXT, status TEXT, booking_id TEXT);
CREATE TABLE IF NOT EXISTS coupons(code TEXT PRIMARY KEY, type TEXT, val INTEGER, max INTEGER, min INTEGER, active INTEGER DEFAULT 1, used INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS banners(id TEXT PRIMARY KEY, text TEXT, enabled INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS otps(mobile TEXT PRIMARY KEY, code_hash TEXT, expires INTEGER, attempts INTEGER DEFAULT 0);
`);

const getSetting = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? JSON.parse(r.value) : d; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v));
const nextSeq = (name, start) => { const n = getSetting(name, start - 1) + 1; setSetting(name, n); return n; };
const tx = (fn) => db.transaction(fn);

module.exports = { db, getSetting, setSetting, nextSeq, tx };
