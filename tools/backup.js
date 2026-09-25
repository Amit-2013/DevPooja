#!/usr/bin/env node
/* npm run backup — timestamped WORKING backup of the whole running app.

   Creates backups/daivikpooja-working-<YYYY-MM-DD-HHMM>/ containing everything
   needed to run the app immediately on another machine or after a disk loss:
     - all source (server/, public/, tests/, tools/, docs, package*.json ...)
     - node_modules/ (prebuilt binaries included -> no `npm install` needed)
     - data/*.db — SQLite databases, WAL-checkpointed first so the copies are
       self-contained (no -wal rows left behind)
     - uploads/ and shared/

   Then compresses the folder (zip on Windows via PowerShell, zip/tar.gz on
   Linux/macOS when available) and prunes old backups, keeping the newest
   BACKUP_KEEP (default 5).

   Deliberately excluded: .git, .freebuff, backups/ itself, dist/ build output,
   root *.zip archives, untracked root images, and .env — a working backup must
   never silently duplicate production secrets; copy that file by hand if you
   keep one locally. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BACKUPS = path.join(ROOT, 'backups');
const PREFIX = 'daivikpooja-working-';
const KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP || '5', 10));
const EXCLUDE_DIRS = new Set(['.git', '.freebuff', 'backups', 'dist']);
const EXCLUDE_ROOT = [/\.zip$/, /^pngtree-.*\.png$/i];

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes());
const dest = path.join(BACKUPS, PREFIX + stamp);

let files = 0, bytes = 0;
function copyTree(src, base) {
  fs.mkdirSync(src === base ? dest : path.join(dest, path.relative(base, src)), { recursive: true });
  for (const name of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, name.name);
    if (name.isDirectory()) {
      if (src === base && EXCLUDE_DIRS.has(name.name)) continue;
      copyTree(from, base);
    } else {
      if (src === base && EXCLUDE_ROOT.some((re) => re.test(name.name))) continue;
      const to = path.join(dest, path.relative(base, from));
      fs.copyFileSync(from, to);
      files++; bytes += fs.statSync(from).size;
    }
  }
}

/* WAL files may hold un-checkpointed rows (same convention as server/migrate.js):
   force a TRUNCATE checkpoint so the copied .db files are complete on their own. */
function checkpointDatabases() {
  if (!fs.existsSync(path.join(ROOT, 'data'))) return;
  let Database;
  try { Database = require('better-sqlite3'); } catch { return console.log('  (better-sqlite3 unavailable — copying db files without checkpoint)'); }
  for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
    if (!f.endsWith('.db')) continue;
    try {
      const d = new Database(path.join(ROOT, 'data', f));
      d.pragma('wal_checkpoint(TRUNCATE)');
      d.close();
      console.log('  checkpointed data/' + f);
    } catch (e) { console.log('  (skip checkpoint data/' + f + ': ' + e.message + ')'); }
  }
}

function compress() {
  if (process.platform === 'win32') {
    const zip = dest + '.zip';
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${dest}' -DestinationPath '${zip}' -Force`], { stdio: 'ignore' });
    return zip;
  }
  try { execFileSync('zip', ['-r', '-q', dest + '.zip', PREFIX + stamp], { cwd: BACKUPS }); return dest + '.zip'; }
  catch { /* zip not installed — fall through to tar */ }
  try { execFileSync('tar', ['-czf', dest + '.tar.gz', '-C', BACKUPS, PREFIX + stamp]); return dest + '.tar.gz'; }
  catch { return null; }
}

/* Keep only the newest KEEP backups (folders + their archives). */
function prune() {
  const entries = fs.readdirSync(BACKUPS)
    .filter((n) => n.startsWith(PREFIX))
    .map((n) => ({ n, t: fs.statSync(path.join(BACKUPS, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { n } of entries.slice(KEEP * 2)) { // each backup = folder + archive = 2 entries
    const p = path.join(BACKUPS, n);
    fs.rmSync(p, { recursive: true, force: true });
    console.log('  pruned old backup: ' + n);
  }
}

fs.mkdirSync(BACKUPS, { recursive: true });
console.log('Backing up to ' + dest);
checkpointDatabases();
copyTree(ROOT, ROOT);
if (process.env.DB_PATH && fs.existsSync(process.env.DB_PATH)) {
  fs.mkdirSync(path.join(dest, 'data'), { recursive: true });
  fs.copyFileSync(process.env.DB_PATH, path.join(dest, 'data', path.basename(process.env.DB_PATH)));
  console.log('  copied DB_PATH: ' + process.env.DB_PATH);
}
if (fs.existsSync(path.join(ROOT, '.env'))) console.log('  NOTE: .env excluded from the backup — copy it manually if needed.');
console.log('  ' + files + ' files, ' + (bytes / 1024 / 1024).toFixed(1) + ' MB');

const zip = compress();
if (zip) console.log('  archive: ' + zip + ' (' + (fs.statSync(zip).size / 1024 / 1024).toFixed(1) + ' MB)');
else console.log('  (no zip/tar available — folder backup only)');
prune();
console.log('Done. Restore: copy the folder anywhere with Node installed and run `npm start`.');
