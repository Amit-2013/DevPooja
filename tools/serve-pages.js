#!/usr/bin/env node
/* Previews the GitHub Pages artifact the way GitHub serves it: from a /<repo>/ subpath.
   Static servers that ignore the subpath would hide exactly the bugs this catches.
   Usage: npm run preview:pages [port] */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
/* Serve from the same subpath GitHub will use, derived from the repo name so that renaming
   the repository cannot silently leave the preview testing the wrong URL. */
const repo = require(path.join(ROOT, 'package.json')).repository;
const name = String((repo && repo.url) || 'DevPooja').replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '').split('/').pop();
const BASE = '/' + name + '/';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon'
};

const port = Number(process.argv[2]) || 4173;

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('No dist/index.html. Run `npm run build:pages` first.');
  process.exit(1);
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/' + name) {
    res.writeHead(302, { Location: BASE });
    return res.end();
  }
  if (!url.pathname.startsWith(BASE)) return send(res, 404, 'Not found');

  const rel = decodeURIComponent(url.pathname.slice(BASE.length)) || 'index.html';
  const file = path.resolve(DIST, rel);
  /* Keep every request inside dist/, even a hand-crafted ../ path. */
  if (file !== DIST && !file.startsWith(DIST + path.sep)) return send(res, 403, 'Forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found');

  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log('Pages preview at http://localhost:' + port + BASE));

function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}
