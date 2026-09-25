/* Seed puja photos: copies the bundled, freely-licensed photos in
   shared/seed-photos/<pujaId>.jpg|png into the puja_media table (migration 009/010)
   as seeded, APPROVED + PUBLISHED primary photos carrying full attribution metadata
   (license, creator, credit, source page, alt text, gallery category) plus a real
   320px thumbnail file in uploads/media.
   - Idempotent: a puja that already has ANY media row is skipped, so admin
     deletions and uploads are never overwritten on restart.
   - Attribution comes from shared/seed-photos/credits.json (generated from the
     Wikimedia Commons API); CREDITS.md is the human-readable copy. */
'use strict';
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const { rid } = require('../lib/util');

const SRC = path.join(__dirname, '..', '..', 'shared', 'seed-photos');
const THUMBS = path.join(SRC, 'thumbs');
const MEDIA_DIR = require('../lib/upload').dirs.media;
const THUMB_SUFFIX = '.t320.jpg';
const VARIANTS = require('./mediaVariants');

function loadCredits() {
  try { return JSON.parse(fs.readFileSync(path.join(SRC, 'credits.json'), 'utf8')).photos || {}; }
  catch (e) { return {}; }
}

/* 320px JPEG thumbnail from the bundled thumbs dir; falls back to a byte-copy of
   the original when no thumb exists (still served as its own file). */
function makeThumb(filename) {
  const base = filename.replace(/-[a-f0-9]+(?=\.)/, ''); // seed-<id>-<rand>.jpg -> seed-<id>.jpg for lookup
  const src = path.join(THUMBS, base.replace(/[.]png$/i, '.jpg'));
  const out = path.join(MEDIA_DIR, filename.replace(/([.][a-z0-9]+)$/i, THUMB_SUFFIX));
  if (fs.existsSync(src)) fs.writeFileSync(out, fs.readFileSync(src));
  else fs.writeFileSync(out, fs.readFileSync(path.join(MEDIA_DIR, filename)));
  return path.basename(out);
}

function seedPujaPhotos() {
  if (!fs.existsSync(SRC)) return { seeded: 0, skipped: 0 };
  const credits = loadCredits();
  const files = fs.readdirSync(SRC).filter((f) => /\.(jpe?g|png)$/i.test(f));
  let seeded = 0, skipped = 0;
  const jobs = [];
  for (const f of files) {
    const pujaId = f.replace(/\.(jpe?g|png)$/i, '');
    if (!db.prepare('SELECT 1 FROM pujas WHERE id=?').get(pujaId)) continue;       // unknown puja id
    if (db.prepare('SELECT 1 FROM puja_media WHERE puja_id=? LIMIT 1').get(pujaId)) { skipped++; continue; }
    const meta = credits[pujaId] || {};
    const buf = fs.readFileSync(path.join(SRC, f));
    const filename = 'seed-' + pujaId + '-' + rid(6) + (/[.]png$/i.test(f) ? '.png' : '.jpg');
    fs.writeFileSync(path.join(MEDIA_DIR, filename), buf);
    const thumb = makeThumb(filename);
    const mime = /[.]png$/i.test(f) ? 'image/png' : 'image/jpeg';
    const id = 'pm' + rid(5);
    const alt = meta.title ? (pujaId.charAt(0).toUpperCase() + pujaId.slice(1) + ' puja — ' + meta.title.replace(/^File:/, '').replace(/[.][a-z]+$/i, '')) : (pujaId + ' puja photo');
    db.prepare(`INSERT INTO puja_media(id,puja_id,uploaded_by,orig_name,filename,mime,size,status,is_primary,is_published,display_order,created_at,
                source,license,credit,creator,credit_url,alt_text,category,thumb)
                VALUES(?,?,?,?,?,?,?,'APPROVED',1,1,0,?, 'seeded',?,?,?,?,?,?,?)`)
      .run(id, pujaId, 'admin1', meta.title || f, filename, mime, buf.length, Date.now(),
        meta.license || 'See shared/seed-photos/CREDITS.md', meta.attribution || '', meta.creator || 'Unknown',
        meta.creditUrl || '', alt, meta.category || 'puja', thumb);
    jobs.push(db.prepare('SELECT * FROM puja_media WHERE id=?').get(id));
    seeded++;
  }
  /* WebP variants for the freshly seeded rows (idempotent; sharp optional). */
  let variants = 0;
  return Promise.all(jobs.map((j) => VARIANTS.ensureVariants(j).then(() => { variants++; })))
    .then(() => ({ seeded, skipped, variants }))
    .catch(() => ({ seeded, skipped, variants }));
}

module.exports = { seedPujaPhotos };
