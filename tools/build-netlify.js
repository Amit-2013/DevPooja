#!/usr/bin/env node
/* Builds dist/ for Netlify (or any static host) as a LIVE frontend.

   Difference from build-pages.js: nothing is captured, no demo shim is installed.
   This build calls your real backend. Configure it in one of three ways:

     1. Write dist/config.js with:  window.DP_API_BASE = 'https://your-api.example.com';
     2. Rebuild with:               DP_API_BASE=https://your-api.example.com npm run build:netlify
     3. Rebuild with .env:          add DP_API_BASE=https://your-api.example.com to .env

   Empty or missing base = same-origin (works when the API and site share one domain).
   The backend must allow the site origin via CORS_ORIGIN when the domains differ. */
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
/* Accept the backend URL as argv[2] or DP_API_BASE (env/.env). */
const base = String(process.argv[2] || process.env.DP_API_BASE || '').trim().replace(/\/+$/, '');

if (base && !/^https?:\/\//i.test(base) && base !== '') {
  console.error('DP_API_BASE must be an absolute http(s) URL, e.g. https://api.example.com');
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), OUT, { recursive: true });

/* shared/pricing.js is served from /shared by Express, so copy it into the static tree. */
fs.mkdirSync(path.join(OUT, 'shared'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'shared', 'pricing.js'), path.join(OUT, 'shared', 'pricing.js'));

/* Same-origin hosted builds get an /api fallback (SPA + safety net); it is harmless on
   Netlify because every real request is absolute API_BASE + /api/... when a base is set. */
const apiTarget = base || 'https://replace-with-your-api.example.com';
fs.writeFileSync(path.join(OUT, '_redirects'),
  '/shared/*  https://replace-with-your-api.example.com/shared/:splat  200\n'.replace('https://replace-with-your-api.example.com', base || apiTarget)
  + '/api/*    ' + (base ? apiTarget + '/api/:splat' : '/api/:splat') + '  200\n'
  + '/*         /index.html   200\n');

/* One tiny file lets you repoint the deployed site at another backend without a rebuild:
   edit config.js and re-upload (or edit it in the Netlify deploy UI). */
fs.writeFileSync(path.join(OUT, 'config.js'),
  '/* STEP 2 of hosting: put your backend URL between the quotes below.\n'
  + '   Example: window.DP_API_BASE = "https://daivikpuja.onrender.com";\n'
  + '   Leave it empty only when the API runs on the same domain as this site. */\n'
  + 'window.DP_API_BASE = ' + JSON.stringify(base) + ';\n');

const html = path.join(OUT, 'index.html');
const marker = '<script src="shared/pricing.js"></script>';
let h = fs.readFileSync(html, 'utf8');
if (!h.includes(marker)) throw new Error('index.html no longer contains the pricing script tag; update build-netlify.js.');
h = h.replace(marker, '<script src="config.js"></script>\n' + marker);
fs.writeFileSync(html, h);

if (!base) {
  console.log('Built ' + path.relative(ROOT, OUT) + '/ in same-origin mode.');
  console.log('Next: edit dist/config.js and put your hosted backend URL in it, or rebuild with:');
  console.log('  node tools/build-netlify.js https://your-backend-url');
} else {
  console.log('Built ' + path.relative(ROOT, OUT) + '/ pointing at ' + base);
}
console.log('Upload the folder contents to Netlify (drag-and-drop) or connect the repo with publish directory "dist".');
