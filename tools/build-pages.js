#!/usr/bin/env node
/* Builds dist/ for GitHub Pages.

   The SPA renders entirely from GET /api/state, so a static site needs exactly one thing:
   real snapshots of that endpoint. This starts the actual app against a throwaway
   database, lets the demo seed run, and captures the state each role is served over HTTP.
   Your own data/ and uploads/ folders are never read, so nothing private can be published. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
const ROLES = ['anon', 'customer', 'pandit', 'admin'];
const tmproot = fs.mkdtempSync(path.join(os.tmpdir(), 'daivikpooja-pages-'));

/* A throwaway database keeps the build reproducible and free of local data. dotenv never
   overrides a variable that is already set, so these values win over any .env file. */
process.env.NODE_ENV = 'development';           /* keeps the demo seed and the fixed demo OTP on */
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'pages-build-secret';
process.env.DB_PATH = path.join(tmproot, 'pages.db');
process.env.UPLOAD_DIR = path.join(tmproot, 'uploads');
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@daivikpuja.in';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
process.env.PAYMENT_MODE = 'mock';              /* never contact a live payment gateway */

const ADMIN = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD };

/* Requiring the app runs bootstrap() against the throwaway database and seeds demo data. */
const app = require(path.join(ROOT, 'server', 'index.js'));

const post = (base, route, body) => fetch(base + route, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}).then(async (r) => {
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('POST ' + route + ' -> ' + r.status + ' ' + (json.error || ''));
  return json;
});

const get = (url, token) => fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }).then(async (r) => {
  if (!r.ok) throw new Error('GET ' + url + ' -> ' + r.status);
  return r.json();
});

/* Each role signs in exactly the way the browser app does, then asks for its own state. */
async function tokenFor(base, role) {
  if (role === 'anon') return '';
  if (role === 'admin') return (await post(base, '/api/auth/admin', ADMIN)).token;
  return (await post(base, '/api/auth/demo', { role: role === 'pandit' ? 'pandit' : 'customer' })).token;
}

function repoUrl() {
  const pkg = require(path.join(ROOT, 'package.json'));
  const url = (pkg.repository && pkg.repository.url) || 'https://github.com/Amit-2013/DevPooja';
  return String(url).replace(/^git\+/, '').replace(/\.git$/, '');
}

function copyPublic() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'public'), OUT, { recursive: true });
  /* pricing.js is served from /shared by the Express app, so it is not inside public/. */
  fs.mkdirSync(path.join(OUT, 'shared'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'shared', 'pricing.js'), path.join(OUT, 'shared', 'pricing.js'));
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
}

/* The static backend must be installed before js/main.js boots the app. */
function injectShim() {
  const file = path.join(OUT, 'index.html');
  const marker = '<script src="js/main.js"></script>';
  const html = fs.readFileSync(file, 'utf8');
  if (!html.includes(marker)) throw new Error('index.html no longer loads js/main.js; update the Pages build to match.');
  fs.writeFileSync(file, html.replace(marker, '<script src="js/pages-demo.js"></script>\n' + marker));
}

async function main() {
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const states = {};
  try {
    for (const role of ROLES) states[role] = await get(base + '/api/state', await tokenFor(base, role));
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }

  copyPublic();
  injectShim();

  const demo = path.join(OUT, 'demo');
  fs.mkdirSync(demo, { recursive: true });
  for (const role of ROLES) fs.writeFileSync(path.join(demo, role + '.json'), JSON.stringify(states[role]));

  /* The shim needs the coupon list to price a coupon client-side, and the published demo
     admin password to render the admin login. Both are documented demo values. */
  fs.writeFileSync(path.join(demo, 'config.json'), JSON.stringify({
    repo: repoUrl(), generated: new Date().toISOString(), admin: ADMIN, coupons: states.admin.coupons
  }, null, 1));

  for (const role of ROLES) {
    console.log('  ' + role.padEnd(8) + ' ' + (fs.statSync(path.join(demo, role + '.json')).size / 1024).toFixed(1) + ' kB  '
      + states[role].catalog.pujas.length + ' pujas, ' + states[role].pandits.length + ' pandits, ' + states[role].bookings.length + ' bookings');
  }
  console.log('Built ' + path.relative(ROOT, OUT) + '/ for GitHub Pages. Preview it with: npm run preview:pages');
}

/* better-sqlite3 keeps the throwaway database open, and Windows refuses to delete an open
   file, so tidying up is best effort: a leftover temp directory must not fail the build. */
function cleanup() {
  try { fs.rmSync(tmproot, { recursive: true, force: true }); } catch (e) { /* leave it to the OS */ }
}

main().then(cleanup, (err) => {
  cleanup();
  console.error('\nPages build failed:', err.message);
  process.exit(1);
});
