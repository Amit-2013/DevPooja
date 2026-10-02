/* Photo + Video Gallery (additional-requirements Phase D) — the single source
   of truth for the public gallery: albums, uploaded photos and YouTube videos
   are admin-managed ROWS, never hard-coded markup.

   Decisions (mirrored in migration 032):
   - Albums group photos AND videos. Deleting an album never deletes media —
     its rows become un-albumed (album_id NULL) and stay in the public tabs,
     because curated images must only disappear through an explicit, audited
     photo/video delete.
   - Photos mirror the people-photo pipeline: quarantine-free single upload
     (the route runs magic-byte verification first), a server-generated name in
     uploads/media and sharp-produced 320px JPEG thumb + WebP pair, plus
     PHOTO-MEDIA-SPEC-style provenance (license/credit/credit_url) so copied
     seed photos keep their attribution.
   - Videos are YouTube links (validated on write); the embed id is derived
     from the URL on read, so hosting video files is never needed.
   - Public reads only ever see active rows inside active albums.

   Every write is audited through lib/audit, exactly like the people CMS. */
'use strict';
const fs = require('fs');
const path = require('path');
const { db, tx } = require('../db');
const { bad, notFound, rid, v } = require('../lib/util');
const { audit } = require('../lib/audit');
const S = require('../lib/serialize');
const upload = require('../lib/upload');

const MEDIA_DIR = upload.dirs.media;
const PAGE_MAX = 48;
let sharp = null;
try { sharp = require('sharp'); }
catch (e) { console.warn('[gallery] sharp unavailable — photo variants disabled:', e.message); }

const runTx = (fn) => tx(fn)();
/* Form fields arrive as strings: 'false'/'0' must mean off, never truthy. */
const flag = (x) => !(x === false || x === 0 || x === '' || String(x).toLowerCase() === 'false' || String(x) === '0');
const exists = (p) => { try { return fs.statSync(p).size > 0; } catch (e) { return false; } };
const unlink = (name) => { if (name) { try { fs.unlinkSync(path.join(MEDIA_DIR, path.basename(name))); } catch (e) { /* already gone */ } } };
const unlinkArtifacts = (names) => names.filter(Boolean).forEach(unlink);

/* --- photo variants (thumb + WebP pair), idempotent ----------------------- */
async function variants(name) {
  const out = { thumb: '', webp: '', thumbWebp: '' };
  const orig = path.join(MEDIA_DIR, path.basename(name));
  if (!exists(orig)) return out;
  const base = String(name).replace(/\.[a-z0-9]+$/i, '');
  const thumb = base + '.t320.jpg', webp = base + '.webp', thumbWebp = base + '.t320.webp';
  if (sharp) {
    try {
      if (!exists(path.join(MEDIA_DIR, thumb))) await sharp(orig).resize({ width: 320, withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(path.join(MEDIA_DIR, thumb));
      if (!exists(path.join(MEDIA_DIR, webp))) await sharp(orig).webp({ quality: 82 }).toFile(path.join(MEDIA_DIR, webp));
      if (exists(path.join(MEDIA_DIR, thumb)) && !exists(path.join(MEDIA_DIR, thumbWebp))) await sharp(path.join(MEDIA_DIR, thumb)).webp({ quality: 80 }).toFile(path.join(MEDIA_DIR, thumbWebp));
    } catch (e) { console.error('[gallery] variants', name, e.message); }
  }
  if (exists(path.join(MEDIA_DIR, thumb))) out.thumb = thumb;
  if (exists(path.join(MEDIA_DIR, webp))) out.webp = webp;
  if (exists(path.join(MEDIA_DIR, thumbWebp))) out.thumbWebp = thumbWebp;
  return out;
}

/* Moves a verified upload into uploads/media under a fresh name. */
function store(file, prefix) {
  const ext = (path.extname(file.originalname || '') || '.jpg').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
  const name = prefix + rid(10) + ext;
  fs.renameSync(file.path, path.join(MEDIA_DIR, name));
  return name;
}
const discard = (file) => { if (file) { try { fs.unlinkSync(file.path); } catch (e) { /* already gone */ } } };

/* Boot/demo-seed repair: fill variant columns where they are still empty. */
async function repairVariants(limit = 200) {
  const rows = db.prepare('SELECT * FROM gallery_photos WHERE thumb IS NULL OR thumb=\'\' LIMIT ?').all(limit);
  let generated = 0;
  for (const r of rows) {
    const vt = await variants(r.filename);
    if (vt.thumb || vt.webp) {
      db.prepare('UPDATE gallery_photos SET thumb=?, webp=?, thumb_webp=? WHERE id=?').run(vt.thumb || null, vt.webp || null, vt.thumbWebp || null, r.id);
      generated++;
    }
  }
  return { processed: rows.length, generated };
}

/* --- albums ---------------------------------------------------------------- */
const getAlbum = (id) => db.prepare('SELECT * FROM gallery_albums WHERE id=?').get(String(id || ''));

/* Counts + cover require the photo set that the caller is allowed to see:
   admin lists count everything, public reads count active rows only. */
function withMeta(r, { admin = false } = {}) {
  const where = admin ? 'album_id=?' : 'album_id=? AND active=1';
  const photoCount = db.prepare('SELECT COUNT(*) c FROM gallery_photos WHERE ' + where).get(r.id).c;
  const videoCount = db.prepare('SELECT COUNT(*) c FROM gallery_videos WHERE ' + where).get(r.id).c;
  const cover = db.prepare('SELECT * FROM gallery_photos WHERE ' + where + ' ORDER BY sort_order, created LIMIT 1').get(r.id);
  return Object.assign(S.galleryAlbum(r), {
    photos: photoCount, videos: videoCount,
    cover: cover ? '/media/' + cover.filename : '',
    coverThumb: cover && cover.thumb ? '/media/' + cover.thumb : '',
    coverWebp: cover && cover.webp ? '/media/' + cover.webp : '',
    coverThumbWebp: cover && cover.thumb_webp ? '/media/' + cover.thumb_webp : ''
  });
}

const listAlbums = () => db.prepare('SELECT * FROM gallery_albums ORDER BY sort_order, name COLLATE NOCASE').all().map((r) => withMeta(r, { admin: true }));
const listActiveAlbums = () => db.prepare('SELECT * FROM gallery_albums WHERE active=1 ORDER BY sort_order, name COLLATE NOCASE').all().map((r) => withMeta(r));

function createAlbum(uid, b) {
  const name = v.str(b.name, 'Album name', { max: 80 });
  const id = 'alb' + rid(5);
  const order = b.order === undefined ? (db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM gallery_albums').get().n) : v.int(b.order, 'Order', { min: 0, max: 999 });
  runTx(() => db.prepare('INSERT INTO gallery_albums(id,name,description,sort_order,active,created,updated) VALUES(?,?,?,?,?,?,?)')
    .run(id, name, v.str(b.description, 'Description', { max: 500, optional: true }), order, b.active === undefined ? 1 : (flag(b.active) ? 1 : 0), Date.now(), Date.now()));
  audit(uid, 'gallery.album_create', 'gallery_album', id, { name, order });
  return withMeta(getAlbum(id), { admin: true });
}

function updateAlbum(uid, id, b) {
  const a = getAlbum(id);
  if (!a) throw notFound('Album not found');
  const sets = [], args = [];
  const put = (col, val) => { sets.push(col + '=?'); args.push(val); };
  if (b.name !== undefined) put('name', v.str(b.name, 'Album name', { max: 80 }));
  if (b.description !== undefined) put('description', v.str(b.description, 'Description', { max: 500, optional: true }));
  if (b.order !== undefined) put('sort_order', v.int(b.order, 'Order', { min: 0, max: 999 }));
  if (b.active !== undefined) put('active', flag(b.active) ? 1 : 0);
  if (!sets.length) throw bad('Nothing to update');
  put('updated', Date.now());
  runTx(() => db.prepare('UPDATE gallery_albums SET ' + sets.join(',') + ' WHERE id=?').run(...args, id));
  const after = getAlbum(id);
  audit(uid, 'gallery.album_update', 'gallery_album', id, { from: { name: a.name, order: a.sort_order, active: a.active }, to: { name: after.name, order: after.sort_order, active: after.active } },
    { oldValue: { active: !!a.active }, newValue: { active: !!after.active } });
  return withMeta(after, { admin: true });
}

/* Delete the grouping only: photos and videos keep existing as un-albumed
   rows (the migration documents this). The media itself survives a mistake. */
function deleteAlbum(uid, id, reason) {
  const a = getAlbum(id);
  if (!a) throw notFound('Album not found');
  const photos = db.prepare('SELECT COUNT(*) c FROM gallery_photos WHERE album_id=?').get(id).c;
  const videos = db.prepare('SELECT COUNT(*) c FROM gallery_videos WHERE album_id=?').get(id).c;
  runTx(() => {
    db.prepare('UPDATE gallery_photos SET album_id=NULL, updated=? WHERE album_id=?').run(Date.now(), id);
    db.prepare('UPDATE gallery_videos SET album_id=NULL, updated=? WHERE album_id=?').run(Date.now(), id);
    db.prepare('DELETE FROM gallery_albums WHERE id=?').run(id);
  });
  audit(uid, 'gallery.album_delete', 'gallery_album', id, { name: a.name, photosMovedOut: photos, videosMovedOut: videos }, reason);
  return { ok: true, photosKept: photos, videosKept: videos };
}

function reorderAlbums(uid, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(String);
  if (!list.length) throw bad('Nothing to reorder');
  runTx(() => list.forEach((id, i) => db.prepare('UPDATE gallery_albums SET sort_order=? WHERE id=?').run(i + 1, id)));
  audit(uid, 'gallery.album_reorder', 'gallery_album', null, { order: list });
  return listAlbums();
}

/* --- photos ---------------------------------------------------------------- */
const getPhoto = (id) => db.prepare('SELECT * FROM gallery_photos WHERE id=?').get(String(id || ''));
const listAllPhotos = () => db.prepare('SELECT * FROM gallery_photos ORDER BY sort_order, created').all().map(S.galleryPhoto);

function albumId(x) {
  const id = String(x === undefined || x === null ? '' : x).trim();
  if (!id) return null;
  if (!getAlbum(id)) throw bad('Choose a valid album');
  return id;
}
const metaStr = (x, label, max) => v.str(x, label, { max, optional: true });

async function addPhoto(uid, b) {
  const file = b.file;
  if (!file) throw bad('Choose a photo to upload');
  if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype || '')) { discard(file); throw bad('Gallery photos must be JPG, PNG or WEBP images'); }
  const album = albumId(b.albumId);
  const name = store(file, 'galp-');
  const vt = await variants(name);
  const id = 'gp' + rid(5);
  const now = Date.now();
  const order = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM gallery_photos').get().n;
  runTx(() => db.prepare(`INSERT INTO gallery_photos(id,album_id,filename,thumb,webp,thumb_webp,caption,alt_text,license,credit,credit_url,sort_order,active,created,updated)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, album, name, vt.thumb || null, vt.webp || null, vt.thumbWebp || null,
      metaStr(b.caption, 'Caption', 200), metaStr(b.altText, 'Alt text', 300),
      metaStr(b.license, 'License', 120), metaStr(b.credit, 'Credit', 200), metaStr(b.creditUrl, 'Credit URL', 300),
      b.order === undefined ? order : v.int(b.order, 'Order', { min: 0, max: 9999 }),
      b.active === undefined ? 1 : (flag(b.active) ? 1 : 0), now, now));
  audit(uid, 'gallery.photo_add', 'gallery_photo', id, { albumId: album, file: name });
  return S.galleryPhoto(getPhoto(id));
}

function updatePhoto(uid, id, b) {
  const p = getPhoto(id);
  if (!p) throw notFound('Photo not found');
  const sets = [], args = [];
  const put = (col, val) => { sets.push(col + '=?'); args.push(val); };
  if (b.caption !== undefined) put('caption', metaStr(b.caption, 'Caption', 200));
  if (b.altText !== undefined) put('alt_text', metaStr(b.altText, 'Alt text', 300));
  if (b.license !== undefined) put('license', metaStr(b.license, 'License', 120));
  if (b.credit !== undefined) put('credit', metaStr(b.credit, 'Credit', 200));
  if (b.creditUrl !== undefined) put('credit_url', metaStr(b.creditUrl, 'Credit URL', 300));
  if (b.albumId !== undefined) put('album_id', albumId(b.albumId));
  if (b.order !== undefined) put('sort_order', v.int(b.order, 'Order', { min: 0, max: 9999 }));
  if (b.active !== undefined) put('active', flag(b.active) ? 1 : 0);
  if (!sets.length) throw bad('Nothing to update');
  put('updated', Date.now());
  runTx(() => db.prepare('UPDATE gallery_photos SET ' + sets.join(',') + ' WHERE id=?').run(...args, id));
  audit(uid, 'gallery.photo_update', 'gallery_photo', id, { from: { albumId: p.album_id, active: p.active }, to: { albumId: b.albumId !== undefined ? albumId(b.albumId) : p.album_id, active: b.active !== undefined ? (flag(b.active) ? 1 : 0) : p.active } });
  return S.galleryPhoto(getPhoto(id));
}

function deletePhoto(uid, id, reason) {
  const p = getPhoto(id);
  if (!p) throw notFound('Photo not found');
  runTx(() => db.prepare('DELETE FROM gallery_photos WHERE id=?').run(id));
  unlinkArtifacts([p.filename, p.thumb, p.webp, p.thumb_webp]);
  audit(uid, 'gallery.photo_delete', 'gallery_photo', id, { caption: p.caption || '', albumId: p.album_id }, reason);
  return { ok: true };
}

function reorderPhotos(uid, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(String);
  if (!list.length) throw bad('Nothing to reorder');
  runTx(() => list.forEach((id, i) => db.prepare('UPDATE gallery_photos SET sort_order=? WHERE id=?').run(i + 1, id)));
  audit(uid, 'gallery.photo_reorder', 'gallery_photo', null, { order: list });
  return { ok: true };
}

/* --- videos ---------------------------------------------------------------- */
const getVideo = (id) => db.prepare('SELECT * FROM gallery_videos WHERE id=?').get(String(id || ''));
const listAllVideos = () => db.prepare('SELECT * FROM gallery_videos ORDER BY sort_order, created').all().map(S.galleryVideo);

function cleanVideoUrl(x) {
  const u = String(x || '').trim().slice(0, 300);
  if (!u) throw bad('Add a video link');
  if (!/^https?:\/\//i.test(u)) throw bad('Video link must start with http:// or https://');
  return u;
}

function createVideo(uid, b) {
  const title = v.str(b.title, 'Title', { max: 120 });
  const id = 'gv' + rid(5);
  const album = albumId(b.albumId);
  const order = b.order === undefined ? (db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM gallery_videos').get().n) : v.int(b.order, 'Order', { min: 0, max: 999 });
  runTx(() => db.prepare('INSERT INTO gallery_videos(id,album_id,title,description,url,sort_order,active,created,updated) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, album, title, v.str(b.description, 'Description', { max: 500, optional: true }), cleanVideoUrl(b.url), order,
      b.active === undefined ? 1 : (flag(b.active) ? 1 : 0), Date.now(), Date.now()));
  audit(uid, 'gallery.video_create', 'gallery_video', id, { title, albumId: album });
  return S.galleryVideo(getVideo(id));
}

function updateVideo(uid, id, b) {
  const vid = getVideo(id);
  if (!vid) throw notFound('Video not found');
  const sets = [], args = [];
  const put = (col, val) => { sets.push(col + '=?'); args.push(val); };
  if (b.title !== undefined) put('title', v.str(b.title, 'Title', { max: 120 }));
  if (b.description !== undefined) put('description', v.str(b.description, 'Description', { max: 500, optional: true }));
  if (b.url !== undefined) put('url', cleanVideoUrl(b.url));
  if (b.albumId !== undefined) put('album_id', albumId(b.albumId));
  if (b.order !== undefined) put('sort_order', v.int(b.order, 'Order', { min: 0, max: 999 }));
  if (b.active !== undefined) put('active', flag(b.active) ? 1 : 0);
  if (!sets.length) throw bad('Nothing to update');
  put('updated', Date.now());
  runTx(() => db.prepare('UPDATE gallery_videos SET ' + sets.join(',') + ' WHERE id=?').run(...args, id));
  audit(uid, 'gallery.video_update', 'gallery_video', id, { from: { url: vid.url, active: vid.active }, to: { url: b.url !== undefined ? b.url : vid.url, active: b.active !== undefined ? (flag(b.active) ? 1 : 0) : vid.active } });
  return S.galleryVideo(getVideo(id));
}

function deleteVideo(uid, id, reason) {
  const vid = getVideo(id);
  if (!vid) throw notFound('Video not found');
  runTx(() => db.prepare('DELETE FROM gallery_videos WHERE id=?').run(id));
  audit(uid, 'gallery.video_delete', 'gallery_video', id, { title: vid.title, albumId: vid.album_id }, reason);
  return { ok: true };
}

function reorderVideos(uid, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(String);
  if (!list.length) throw bad('Nothing to reorder');
  runTx(() => list.forEach((id, i) => db.prepare('UPDATE gallery_videos SET sort_order=? WHERE id=?').run(i + 1, id)));
  audit(uid, 'gallery.video_reorder', 'gallery_video', null, { order: list });
  return { ok: true };
}

/* --- reads ----------------------------------------------------------------- */
const clampLimit = (x) => Math.max(1, Math.min(PAGE_MAX, parseInt(x, 10) || 12));
const clampOffset = (x) => Math.max(0, parseInt(x, 10) || 0);

/* Shared filter for the public joins. LEFT JOIN on purpose: an un-albumed row
   (never grouped, or left behind by a deleted album) still belongs to the
   public Photos/Videos tabs — only a HIDDEN album hides its members. SQL
   fragments and bind values stay in separate arrays so a literal is never
   bound as a parameter. */
function filterWhere(alias, album) {
  const parts = [alias + '.active=1', '(a.id IS NULL OR a.active=1)'];
  const params = [];
  if (album) { parts.push(alias + '.album_id=?'); params.push(String(album)); }
  return { where: parts.join(' AND '), params };
}

function publicPhotos({ album, limit, offset } = {}) {
  const lim = clampLimit(limit), off = clampOffset(offset);
  const f = filterWhere('p', album);
  const from = ' FROM gallery_photos p LEFT JOIN gallery_albums a ON a.id=p.album_id WHERE ';
  const total = db.prepare('SELECT COUNT(*) c' + from + f.where).get(...f.params).c;
  const rows = db.prepare('SELECT p.*' + from + f.where + ' ORDER BY p.sort_order, p.created LIMIT ? OFFSET ?').all(...f.params, lim, off);
  return { photos: rows.map(S.galleryPhoto), total, nextOffset: off + rows.length < total ? off + rows.length : null };
}

function publicVideos({ album, limit, offset } = {}) {
  const lim = clampLimit(limit), off = clampOffset(offset);
  const f = filterWhere('v', album);
  const from = ' FROM gallery_videos v LEFT JOIN gallery_albums a ON a.id=v.album_id WHERE ';
  const total = db.prepare('SELECT COUNT(*) c' + from + f.where).get(...f.params).c;
  const rows = db.prepare('SELECT v.*' + from + f.where + ' ORDER BY v.sort_order, v.created LIMIT ? OFFSET ?').all(...f.params, lim, off);
  return { videos: rows.map(S.galleryVideo), total, nextOffset: off + rows.length < total ? off + rows.length : null };
}

/* Public endpoint: kind=photos|videos|albums picks the tab; the album filter
   narrows photos/videos. Every response carries the active album cards so the
   filter chips never need a second request. */
function publicGallery(q = {}) {
  const kind = ['photos', 'videos', 'albums'].includes(String(q.kind || '')) ? String(q.kind) : 'photos';
  const album = q.album ? String(q.album) : '';
  if (album && !(getAlbum(album) || {}).active) throw bad('Album not found');
  const out = { kind, albums: listActiveAlbums() };
  if (kind === 'albums') return out;
  const page = kind === 'videos' ? publicVideos({ album, limit: q.limit, offset: q.offset }) : publicPhotos({ album, limit: q.limit, offset: q.offset });
  return Object.assign(out, page, { total: page.total, nextOffset: page.nextOffset });
}

/* Compact overview that rides along in /state so the public page renders
   instantly; "load more" pages through publicGallery. */
function overview() {
  const first = publicPhotos({ limit: 24 });
  const vids = publicVideos({ limit: 50 });
  return { albums: listActiveAlbums(), photos: first.photos, videos: vids.videos, totalPhotos: first.total, totalVideos: vids.total };
}

const adminBundle = () => ({ albums: listAlbums(), photos: listAllPhotos(), videos: listAllVideos() });

module.exports = {
  getAlbum, listAlbums, listActiveAlbums, createAlbum, updateAlbum, deleteAlbum, reorderAlbums,
  listAllPhotos, addPhoto, updatePhoto, deletePhoto, reorderPhotos,
  listAllVideos, createVideo, updateVideo, deleteVideo, reorderVideos,
  publicGallery, publicPhotos, publicVideos, overview, adminBundle,
  /* exported for the demo seeder / boot repair / tests */
  variants, repairVariants
};
