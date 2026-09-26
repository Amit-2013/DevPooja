/* WebP variants for puja media (migration 011 / PHOTO-MEDIA-SPEC.md thumbnails rule).
   Pipeline per photo: original (source of truth, untouched) -> 320px JPEG thumb
   (existing) -> 320px WebP thumb + full-size WebP (generated here with sharp).
   Idempotency: a row is only processed when its `webp`/`thumb_webp` column is empty,
   and the target file is only written when missing — restarts and re-deploys never
   regenerate existing variants. On Render's ephemeral disk the files are recreated
   from the preserved originals on boot; on persistent disks the boot pass is a no-op. */
'use strict';
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const upload = require('../lib/upload');

const MEDIA_DIR = upload.dirs.media;
const THUMB_SUFFIX = '.t320.jpg';
const THUMB_WEBP_SUFFIX = '.t320.webp';
const WEBP_SUFFIX = '.webp';
let sharp = null;
try { sharp = require('sharp'); }
catch (e) {
  /* sharp's @img/* platform binaries are OPTIONAL npm deps: a flaked prebuild
     download is silently skipped by the installer, which lands here. Variants
     stay disabled without sharp, but this must never be silent — CI and
     deployments need to see why (a retry of npm ci usually fixes it). */
  console.warn('[mediaVariants] sharp unavailable — WebP variants disabled:', e.message);
}

const baseName = (f) => String(f || '').replace(/\.[a-z0-9]+$/i, '');
const exists = (p) => { try { return fs.statSync(p).size > 0; } catch { return false; } };

/* Generate both WebP variants for one media row's files (if missing). */
async function ensureVariants(row) {
  if (!sharp) return row;
  const origPath = path.join(MEDIA_DIR, path.basename(row.filename));
  const thumbName = path.basename(row.thumb || (baseName(row.filename) + THUMB_SUFFIX));
  const thumbPath = path.join(MEDIA_DIR, thumbName);
  const updates = {};
  try {
    if (!/^image\/(jpeg|png)$/.test(row.mime || '')) return row; // only raster sources
    /* full-size WebP: <orig-base>.webp */
    const webpName = baseName(row.filename) + WEBP_SUFFIX;
    const webpPath = path.join(MEDIA_DIR, webpName);
    if (!exists(webpPath) && exists(origPath)) await sharp(origPath).webp({ quality: 82 }).toFile(webpPath);
    if (exists(webpPath)) updates.webp = webpName;
    /* thumb WebP: same name as the JPEG thumb with .webp extension (normalized:
       legacy rows may carry a doubled .t320.t320.webp name — rename on repair) */
    let thumbWebpName = thumbName.replace(/\.t320\.jpg$/i, THUMB_WEBP_SUFFIX);
    if (!/\.webp$/i.test(thumbWebpName)) thumbWebpName = baseName(thumbName) + THUMB_WEBP_SUFFIX;
    const legacyName = baseName(thumbName) + THUMB_WEBP_SUFFIX;
    const legacyPath = legacyName !== thumbWebpName ? path.join(MEDIA_DIR, legacyName) : null;
    const tPath = path.join(MEDIA_DIR, thumbWebpName);
    if (!exists(tPath)) {
      if (legacyPath && exists(legacyPath)) fs.renameSync(legacyPath, tPath);           // normalize old doubled name
      else if (exists(thumbPath)) await sharp(thumbPath).webp({ quality: 80 }).toFile(tPath);
    }
    if (exists(tPath)) updates.thumb_webp = thumbWebpName;
    const sets = [], args = [];
    if (updates.webp && row.webp !== updates.webp) { sets.push('webp=?'); args.push(updates.webp); }
    if (updates.thumb_webp && row.thumb_webp !== updates.thumb_webp) { sets.push('thumb_webp=?'); args.push(updates.thumb_webp); }
    if (sets.length) db.prepare('UPDATE puja_media SET ' + sets.join(', ') + ' WHERE id=?').run(...args, row.id);
    return Object.assign({}, row, updates);
  } catch (e) { console.error('[mediaVariants]', row.id, e.message); return row; }
}

/* Boot-time repair: fill variants only where columns are empty. Returns counts. */
async function repairAll(limit = 200) {
  if (!sharp) return { processed: 0, generated: 0, skipped: 'sharp unavailable' };
  const rows = db.prepare("SELECT * FROM puja_media WHERE webp IS NULL OR webp='' OR thumb_webp IS NULL OR thumb_webp='' LIMIT ?").all(limit);
  let generated = 0;
  for (const r of rows) {
    const before = { w: r.webp, t: r.thumb_webp };
    const after = await ensureVariants(r);
    if (after.webp !== before.w || after.thumb_webp !== before.t) generated++;
  }
  return { processed: rows.length, generated };
}

/* Variant payload for API responses (URLs resolved by the serializer). */
const variantPaths = (r) => ({ webp: r.webp || '', thumbWebp: r.thumb_webp || '' });

module.exports = { ensureVariants, repairAll, variantPaths, THUMB_SUFFIX, THUMB_WEBP_SUFFIX, WEBP_SUFFIX };
