#!/usr/bin/env node
/* Smoke test for the GitHub Pages artifact — "the demo must work from a static host".

   Builds dist/ when it is missing (--build forces a rebuild), serves it exactly the way
   GitHub Pages does — from the /<repo>/ subpath through tools/serve-pages.js, because a
   server that ignores the subpath hides exactly the bugs this catches — and asserts:

     1. index.html carries the shim (window.DP_API_BASE + js/pages-demo.js loaded before
        js/main.js) and every script/stylesheet it names resolves over HTTP;
     2. every demo/*.json snapshot the static backend fetches serves and parses, with
        real rows (pujas, gallery, people, the seeded NRI catalogue, kundali prices);
     3. PagesDemo.request() answers every read beyond /state with snapshot data — gallery
        paging incl. a past-end empty page, people profile + 404, NRI packages, kundali
        pricing, puja photos with offset AND page paging — and still refuses writes with
        the blocked() message;
     4. every /media/... name the artifact references exists in dist/media AND loads over
        HTTP (the build-time trim must never drop a live image).

   Run: node tests/pages-smoke.js [--build]   (CI runs it right after `npm run build:pages`) */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const TOOLS = path.join(ROOT, 'tools');
/* Same subpath derivation as tools/serve-pages.js and tools/build-pages.js, so renaming
   the repository can never leave this test probing the wrong URL. */
const repo = require(path.join(ROOT, 'package.json')).repository;
const NAME = String((repo && repo.url) || 'DevPooja').replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '').split('/').pop();

let passed = 0;
const failures = [];
const check = (cond, msg, detail) => {
  if (cond) { passed++; return true; }
  failures.push(msg + (detail ? ' — ' + detail : ''));
  console.log('FAIL  ' + msg + (detail ? ' — ' + detail : ''));
  return false;
};

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(cmd + ' exited with ' + code))));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/* Serve dist/ through the real preview server and wait until it answers. */
async function serve(port) {
  const child = spawn(process.execPath, [path.join(TOOLS, 'serve-pages.js'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write('  serve: ' + d));
  child.stderr.on('data', (d) => process.stderr.write('  serve: ' + d));
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/', { redirect: 'manual' }); if (r.status) return child; }
    catch (e) { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error('tools/serve-pages.js did not start on port ' + port);
}

async function main() {
  if (process.argv.includes('--build') || !fs.existsSync(path.join(DIST, 'index.html'))) {
    console.log('building dist/ first…');
    await run(process.execPath, [path.join(TOOLS, 'build-pages.js')]);
  }
  const port = await freePort();
  const child = await serve(port);
  const BASE = 'http://127.0.0.1:' + port + '/' + NAME + '/';
  const get = async (rel) => { const r = await fetch(BASE + rel); return { status: r.status, body: await r.text() }; };

  try {
    /* ---------- 1. the shim in index.html + every asset it names ---------- */
    console.log('index.html shim + assets');
    const idx = await get('');
    check(idx.status === 200, 'GET /' + NAME + '/ index.html', 'status ' + idx.status);
    check(idx.body.includes('window.DP_API_BASE="/' + NAME + '"'), 'index.html sets window.DP_API_BASE to the repo subpath');
    const demoAt = idx.body.indexOf('js/pages-demo.js'), mainAt = idx.body.indexOf('js/main.js');
    check(demoAt > -1 && mainAt > -1 && demoAt < mainAt, 'js/pages-demo.js loads before js/main.js');
    const assets = [...idx.body.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
      .filter((u) => !/^(https?:|data:|#|mailto:)/.test(u));
    check(assets.length >= 5, 'index.html names its scripts/stylesheets', 'found ' + assets.length);
    for (const a of assets) {
      const r = await fetch(BASE + a);
      const buf = await r.arrayBuffer();
      check(r.status === 200 && buf.byteLength > 0, 'asset ' + a, 'status ' + r.status + ', ' + buf.byteLength + ' B');
    }

    /* ---------- 2. the demo/*.json snapshots the static backend serves ---------- */
    console.log('demo snapshots');
    const snaps = {};
    for (const n of ['anon', 'customer', 'pandit', 'admin', 'config', 'people', 'nri-packages', 'kundali', 'puja-photos']) {
      const r = await fetch(BASE + 'demo/' + n + '.json');
      check(r.status === 200, 'demo/' + n + '.json', 'status ' + r.status);
      try { snaps[n] = await r.json(); } catch (e) { check(false, 'demo/' + n + '.json parses', e.message); }
    }
    const anon = snaps.anon || {};
    const gal = anon.gallery || {};
    check(((anon.catalog || {}).pujas || []).length > 0, 'anon snapshot carries catalogue pujas');
    check((gal.photos || []).length > 0 && (gal.videos || []).length > 0 && (gal.albums || []).length > 0, 'anon snapshot carries gallery rows');
    const peopleMap = snaps.people || {};
    const peopleIds = Object.keys(peopleMap);
    check(peopleIds.length > 0, 'people snapshot carries profiles');
    const nriPkgs = (snaps['nri-packages'] || {}).packages || [];
    check(nriPkgs.length > 0 && nriPkgs[0].price > 0 && !!nriPkgs[0].currency, 'nri-packages snapshot carries the seeded catalogue');
    check(Object.keys((snaps.kundali || {}).prices || {}).length > 0, 'kundali snapshot carries prices');
    const photoMap = snaps['puja-photos'] || {};
    const photoPuja = Object.keys(photoMap).find((id) => (((photoMap[id] || {}).photos || []).length > 0));
    check(!!photoPuja, 'puja-photos snapshot carries photos');
    check(!!((snaps.config || {}).admin || {}).email, 'config snapshot carries the demo admin');

    /* ---------- 3. PagesDemo.request(): the static fallbacks ---------- */
    console.log('PagesDemo.request() fallbacks');
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: BASE, runScripts: 'outside-only' });
    const w = dom.window;
    /* Relative demo/*.json fetches must resolve against the subpath, exactly as on the page. */
    w.fetch = (u, o) => fetch(new URL(String(u), BASE), o);
    w.sessionStorage.setItem('dp-demo-off', '1');   /* keep the demo banner out of the way */
    w.eval(fs.readFileSync(path.join(DIST, 'js', 'pages-demo.js'), 'utf8'));
    const req = (w.PagesDemo || {}).request;
    if (check(typeof req === 'function', 'dist/js/pages-demo.js defines window.PagesDemo.request')) {
      const ok = async (label, pathOrFn, assert) => {
        try {
          const v = await pathOrFn();
          const msg = assert(v);
          check(!msg, label, msg || '');
        } catch (e) { check(false, label, 'threw ' + e.message); }
      };
      const refuse = async (label, fn, want) => {
        try { await fn(); check(false, label, 'unexpectedly resolved'); }
        catch (e) { check(String(e.message).includes(want), label, 'got: ' + e.message); }
      };

      await ok('/state serves the anon snapshot', () => req('/state'),
        (v) => (((v || {}).catalog || {}).pujas || []).length > 0 ? null : 'no pujas');
      await ok('gallery first page', () => req('/gallery?kind=photos&limit=3&offset=0'), (v) => {
        if (v.kind !== 'photos') return 'kind ' + v.kind;
        if (!Array.isArray(v.photos)) return 'no photos array';
        if (v.total !== (gal.photos || []).length) return 'total ' + v.total;
        if (v.photos.length !== Math.min(3, v.total)) return 'page has ' + v.photos.length;
        if (v.nextOffset !== (v.total > 3 ? 3 : null)) return 'nextOffset ' + v.nextOffset;
        if (!(v.albums || []).length) return 'no album cards';
        return null;
      });
      await ok('gallery offset past the end', () => req('/gallery?kind=photos&limit=3&offset=100000'), (v) => {
        if (!v || v.photos.length !== 0) return 'expected an empty page';
        if (v.nextOffset !== null) return 'nextOffset ' + v.nextOffset;
        if (v.total !== (gal.photos || []).length) return 'total changed to ' + v.total;
        return null;
      });
      await ok('gallery videos + albums kinds', async () => ({
        v: await req('/gallery?kind=videos&limit=50'),
        a: await req('/gallery?kind=albums')
      }), ({ v, a }) => {
        if (!Array.isArray(v.videos) || v.videos.length !== (gal.videos || []).length) return 'video feed wrong';
        if (!Array.isArray(a.albums) || a.albums.length !== (gal.albums || []).length) return 'album feed wrong';
        return null;
      });
      await ok('people profile', () => req('/people/' + encodeURIComponent(peopleIds[0])), (v) =>
        v && v.person && (v.person.n || v.person.name) ? null : 'no person name');
      await refuse('people profile 404', () => req('/people/__no-such-person__'), 'Person not found');
      await ok('puja photos (offset paging)', () => req('/pujas/' + encodeURIComponent(photoPuja) + '/photos?limit=2&offset=0'), (v) => {
        const total = ((photoMap[photoPuja] || {}).photos || []).length;
        if (v.total !== total) return 'total ' + v.total;
        if (v.photos.length !== Math.min(2, total)) return 'page has ' + v.photos.length;
        if (v.offset !== 0) return 'offset ' + v.offset;
        return null;
      });
      await ok('puja photos offset past the end', () => req('/pujas/' + encodeURIComponent(photoPuja) + '/photos?limit=2&offset=100000'),
        (v) => (v.photos.length === 0 && v.nextOffset === null && v.total === ((photoMap[photoPuja] || {}).photos || []).length)
          ? null : 'expected an empty, total-preserving page');
      await ok('puja photos (page fallback)', () => req('/pujas/' + encodeURIComponent(photoPuja) + '/photos?limit=2&page=1'),
        (v) => (v.offset === 0 && v.photos.length === Math.min(2, v.total)) ? null : 'page=1 must behave like offset=0');
      await ok('nri packages', () => req('/nri-packages'),
        (v) => ((v || {}).packages || []).length === nriPkgs.length ? null : 'package count ' + (v || {}).packages);
      await ok('kundali pricing', () => req('/kundali/pricing'),
        (v) => (Object.keys((v || {}).prices || {}).length === Object.keys((snaps.kundali || {}).prices || {}).length) ? null : 'price set differs');
      await refuse('admin write still blocked', () => req('/admin/pujas', { method: 'POST', body: '{}' }), 'read-only');
      await refuse('booking write still blocked', () => req('/bookings', { method: 'POST', body: '{}' }), 'Booking, payments and orders need the Express + SQLite API');
      dom.window.close();
    }

    /* ---------- 4. every referenced /media/ image resolves ---------- */
    console.log('media references');
    const refs = new Set();
    const re = /(?:^|[\s'"`(=])\/media\/([^"'`)\s?#]+)/gm;
    const scan = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const f = path.join(p, e.name);
        if (e.isDirectory()) { if (f !== path.join(DIST, 'media')) scan(f); continue; }
        if (!/\.(json|html|js|css)$/i.test(e.name)) continue;
        const text = fs.readFileSync(f, 'utf8');
        let m; re.lastIndex = 0;
        while ((m = re.exec(text))) {
          const name = decodeURIComponent(m[1]);
          if (/\.(jpe?g|png|webp|gif|avif|svg|mp4|webm)$/i.test(name)) refs.add(name);
        }
      }
    };
    scan(DIST);
    check(refs.size > 0, 'the artifact must reference /media/ images', 'found ' + refs.size);
    for (const name of [...refs].sort()) {
      check(fs.existsSync(path.join(DIST, 'media', name)), 'media file on disk: ' + name);
      const r = await fetch(BASE + 'media/' + encodeURI(name));
      const buf = await r.arrayBuffer();
      check(r.status === 200 && buf.byteLength > 0, 'media resolves: ' + name, 'status ' + r.status + ', ' + buf.byteLength + ' B');
    }
  } finally {
    child.kill();
  }

  console.log('');
  if (failures.length) {
    console.error('PAGES SMOKE FAILED — ' + failures.length + ' of ' + (passed + failures.length) + ' checks failed');
    process.exitCode = 1;
  } else {
    console.log('PAGES SMOKE OK — ' + passed + ' checks passed');
  }
}

main().catch((e) => { console.error('PAGES SMOKE FAILED — ' + (e && e.stack || e)); process.exitCode = 1; });
