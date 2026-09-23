#!/usr/bin/env node
/* Applies pending SQL migrations from server/migrations/ in filename order.

   - Creates schema_migrations and records every applied file, so re-running is safe.
   - Takes a file-level backup of the database before the first pending migration.
   - Migration SQL must be written to be idempotent (IF NOT EXISTS / INSERT ... SELECT),
     because a file can be interrupted mid-apply on some systems; re-running must not
     duplicate data or fail.

   Usage:
     node server/migrate.js            apply pending migrations
     node server/migrate.js --status   list applied and pending files
*/
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { db } = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/* Ensures the tracking table exists and returns its name. */
function ensureTracking() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

function appliedSet() {
  return new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
}

function available() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

function backup(dest) {
  const file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'daivikpooja.db');
  if (file === ':memory:') return null;
  const dir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, dest);
  fs.copyFileSync(file, target);
  /* WAL may hold un-checkpointed rows; force a checkpoint so the backup file is complete. */
  db.pragma('wal_checkpoint(TRUNCATE)');
  return target;
}

function status() {
  ensureTracking();
  const done = appliedSet();
  const files = available();
  const pending = files.filter((f) => !done.has(f));
  console.log('Applied:');
  for (const name of [...done].sort()) console.log('  + ' + name);
  if (!done.size) console.log('  (none)');
  console.log('Pending:');
  for (const f of pending) console.log('  - ' + f);
  if (!pending.length) console.log('  (none)');
}

function run() {
  ensureTracking();
  const done = appliedSet();
  const pending = available().filter((f) => !done.has(f));
  if (!pending.length) return console.log('No pending migrations.');

  const stamp = path.basename(backup('pre-migration-' + Date.now() + '.db') || 'none');
  console.log('Backup: backups/' + stamp);

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run(file);
    });
    try {
      apply();
      console.log('Applied ' + file);
    } catch (err) {
      console.error('FAILED ' + file + ': ' + err.message);
      console.error('The transaction rolled back. Fix the SQL and re-run; nothing else was touched.');
      process.exit(1);
    }
  }
  console.log('Done. ' + pending.length + ' migration(s) applied.');
}

if (process.argv.includes('--status')) status();
else run();
