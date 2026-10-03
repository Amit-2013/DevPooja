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

function du(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? du(p) : fs.statSync(p).size;
  }
  return total;
}

/* Phase E follow-up: the published media was a flat copy of the throwaway
   build's upload dir — 13.5 MB for a demo. Two kinds of dead weight:
     (1) by-product files no snapshot references (several full-size WebP variants
         the lightbox never asks for),
     (2) images at camera-scan quality — including "320px thumbnails" that are
         byte-for-byte copies of the 960x1280 original.
   Both are trimmed HERE, at build time only (the running app and the API are
   untouched): every file the published HTML/JS/JSON never names is dropped, and
   the rest is re-encoded with sharp under the same filename and format, so every
   /media/... URL in the snapshot keeps resolving. Caps: *.t320.* -> 320px wide,
   everything else -> 1600px wide; a re-encode is only kept when it is actually
   smaller. sharp is an optional dependency of the app: without it we publish the
   originals as-is (bigger, never broken). */
async function trimMedia() {
  const dir = path.join(OUT, 'media');
  if (!fs.existsSync(dir)) return null;
  const before = du(dir);

  /* Collect every /media/<file> the artifact actually names: the role
     snapshots, the captured extras, and any literal in the shipped HTML/JS. */
  const refs = new Set();
  const scan = (text) => {
    /* Require a delimiter before /media/ so "…/admin/media/bulk" (an API route)
       never reads as a file reference. */
    const re = /(?:^|[\s'"`(=])\/media\/([^"'`)\s?#]+)/gm;
    let m;
    while ((m = re.exec(text))) {
      /* Only real asset names count — UI copy like placeholder="/media/… or
         https://…" and API routes like /admin/media/bulk must not. */
      const name = decodeURIComponent(m[1]);
      if (/\.(jpe?g|png|webp|gif|avif|svg|mp4|webm)$/i.test(name)) refs.add(name);
    }
  };
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) { if (f !== dir) walk(f); continue; }
      if (!/\.(json|html|js|css)$/i.test(e.name)) continue;
      scan(fs.readFileSync(f, 'utf8'));
    }
  };
  walk(OUT);

  let dropped = 0, kept = 0, shrunk = 0;
  let sharp = null;
  try { sharp = require('sharp'); } catch (e) { /* optional dependency: publish as-is */ }

  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (!refs.has(name)) { fs.unlinkSync(file); dropped++; continue; }
    kept++;
    if (!sharp) continue;
    try {
      const stat = fs.statSync(file);
      const cap = /\.t320\./.test(name) ? 320 : 1600;
      const meta = await sharp(file).metadata();
      if (!meta.width && !meta.height) continue;
      if (meta.width <= cap && stat.size <= 128 * 1024) continue;   /* already small */
      const tmp = file.replace(/(\.[a-z0-9]+)$/i, '.out$1');
      let p = sharp(file).resize({ width: cap, height: cap, fit: 'inside', withoutEnlargement: true });
      if (/\.webp$/i.test(name)) p = p.webp({ quality: 75 });
      else if (/\.png$/i.test(name)) p = p.png({ compressionLevel: 9 });
      else p = p.jpeg({ quality: 72, mozjpeg: true, progressive: true });
      await p.toFile(tmp);
      const out = fs.statSync(tmp);
      if (out.size < stat.size) { fs.renameSync(tmp, file); shrunk++; }
      else fs.unlinkSync(tmp);
    } catch (e) { /* unreadable image: publish the original rather than drop it */ }
  }

  /* Every referenced name must still exist — a miss here would 404 in the demo. */
  const missing = [...refs].filter((n) => !fs.existsSync(path.join(dir, n)));
  if (missing.length) console.warn('  media  WARNING still missing: ' + missing.join(', '));
  const after = du(dir);
  return { before, after, dropped, kept, shrunk, missing: missing.length };
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
  /* Phase E: every image the snapshot references lives in the throwaway upload
     dir (seeded gallery, people and puja photos + their variants). A static host
     has no /media route, so publish the files themselves. */
  const media = path.join(process.env.UPLOAD_DIR, 'media');
  if (fs.existsSync(media)) fs.cpSync(media, path.join(OUT, 'media'), { recursive: true });
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
}

/* GitHub Pages serves a project site from a /<repo>/ subpath, but the API
   payloads carry root-relative /media/… urls. Pointing API_BASE at the subpath
   makes mediaUrl() resolve them under it (api() itself is served by the static
   shim, which fetches demo/*.json relatively). Same derivation as
   tools/serve-pages.js, so the preview tests the URL GitHub will use. */
function repoBasePath() {
  const pkg = require(path.join(ROOT, 'package.json'));
  const name = String((pkg.repository && pkg.repository.url) || 'DevPooja')
    .replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '').split('/').pop();
  return '/' + name;
}

/* The static backend must be installed before js/main.js boots the app, and
   API_BASE must be set before js/core.js computes it from window.DP_API_BASE. */
function injectShim() {
  const file = path.join(OUT, 'index.html');
  const marker = '<script src="js/main.js"></script>';
  const core = '<script src="js/core.js"></script>';
  const html = fs.readFileSync(file, 'utf8');
  if (!html.includes(marker)) throw new Error('index.html no longer loads js/main.js; update the Pages build to match.');
  if (!html.includes(core)) throw new Error('index.html no longer loads js/core.js; update the Pages build to match.');
  fs.writeFileSync(file, html
    .replace(marker, '<script src="js/pages-demo.js"></script>\n' + marker)
    .replace(core, '<script>window.DP_API_BASE=' + JSON.stringify(repoBasePath()) + ';</script>\n' + core));
}

async function main() {
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const states = {};
  let extras = null;
  try {
    for (const role of ROLES) states[role] = await get(base + '/api/state', await tokenFor(base, role));
    /* Phase E: the read endpoints the static shim serves beyond /state — people
       profiles, NRI packages, kundali pricing and the per-puja photo gallery —
       captured here from the same throwaway server, so they are genuine rows. */
    const dir = await get(base + '/api/people', '');
    const people = {};
    for (const p of dir.people) people[p.id] = (await get(base + '/api/people/' + encodeURIComponent(p.id), '')).person;
    const pujaPhotos = {};
    for (const p of states.anon.catalog.pujas) pujaPhotos[p.id] = await get(base + '/api/pujas/' + p.id + '/photos?limit=48&page=1', '');
    extras = {
      people,
      nri: await get(base + '/api/nri-packages', ''),
      kundali: await get(base + '/api/kundali/pricing', ''),
      pujaPhotos
    };
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }

  copyPublic();
  injectShim();

  const demo = path.join(OUT, 'demo');
  fs.mkdirSync(demo, { recursive: true });
  for (const role of ROLES) fs.writeFileSync(path.join(demo, role + '.json'), JSON.stringify(states[role]));

  /* Phase E read fallbacks: one file per endpoint group, fetched lazily by
     js/pages-demo.js only when the visitor opens that page. */
  fs.writeFileSync(path.join(demo, 'people.json'), JSON.stringify(extras.people));
  fs.writeFileSync(path.join(demo, 'nri-packages.json'), JSON.stringify(extras.nri));
  fs.writeFileSync(path.join(demo, 'kundali.json'), JSON.stringify(extras.kundali));
  fs.writeFileSync(path.join(demo, 'puja-photos.json'), JSON.stringify(extras.pujaPhotos));

  /* The shim needs the coupon list to price a coupon client-side, and the published demo
     admin password to render the admin login. Both are documented demo values. */
  fs.writeFileSync(path.join(demo, 'config.json'), JSON.stringify({
    repo: repoUrl(), generated: new Date().toISOString(), admin: ADMIN, coupons: states.admin.coupons
  }, null, 1));

  for (const role of ROLES) {
    console.log('  ' + role.padEnd(8) + ' ' + (fs.statSync(path.join(demo, role + '.json')).size / 1024).toFixed(1) + ' kB  '
      + states[role].catalog.pujas.length + ' pujas, ' + states[role].pandits.length + ' pandits, ' + states[role].bookings.length + ' bookings');
  }
  for (const f of ['people.json', 'nri-packages.json', 'kundali.json', 'puja-photos.json']) {
    console.log('  extra  ' + f.padEnd(18) + ' ' + (fs.statSync(path.join(demo, f)).size / 1024).toFixed(1) + ' kB');
  }
  const trim = await trimMedia();
  const mediaDir = path.join(OUT, 'media');
  if (fs.existsSync(mediaDir)) {
    const files = fs.readdirSync(mediaDir).length;
    console.log('  media  ' + files + ' files, ' + (du(mediaDir) / 1024 / 1024).toFixed(1) + ' MB'
      + (trim ? ' (trimmed from ' + (trim.before / 1024 / 1024).toFixed(1) + ' MB: '
        + trim.dropped + ' unreferenced dropped, ' + trim.shrunk + ' re-encoded, ' + trim.missing + ' missing)' : ''));
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
