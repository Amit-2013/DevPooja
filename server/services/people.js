/* Our People CMS (additional-requirements Phase B) — the single source of truth
   for the people the platform presents: Founder, Main Acharya, acharyas, Vedic
   scholars, jyotish experts, pandits, temple representatives, advisors and the
   team. Nothing here is hard-coded content: every row (including the Founder
   and the Main Acharya) is created, ordered, categorised, published or hidden
   by an admin, and every write is audited.

   Categories are reference data seeded by migration 030; people are ordinary
   rows. Deleting a category is refused while people still use it (deactivate
   instead), and deleting a person removes their own gallery rows + stored
   artifacts because nothing else references them.

   Photo pipeline mirrors puja media: the upload lands in the kyc quarantine
   directory, magic bytes are verified by the route middleware, then the file
   moves into uploads/media under a server-generated name and sharp (optional
   dependency) produces a 320px JPEG thumb + WebP pair. Public reads only ever
   see active people in active categories. */
'use strict';
const fs = require('fs');
const path = require('path');
const { db, tx } = require('../db');
const { bad, notFound, rid, v } = require('../lib/util');
const { audit } = require('../lib/audit');
const S = require('../lib/serialize');
const upload = require('../lib/upload');

const MEDIA_DIR = upload.dirs.media;
const MAX_PHOTOS = 12;
let sharp = null;
try { sharp = require('sharp'); }
catch (e) { console.warn('[people] sharp unavailable — photo variants disabled:', e.message); }

const runTx = (fn) => tx(fn)();
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
    } catch (e) { console.error('[people] variants', name, e.message); }
  }
  if (exists(path.join(MEDIA_DIR, thumb))) out.thumb = thumb;
  if (exists(path.join(MEDIA_DIR, webp))) out.webp = webp;
  if (exists(path.join(MEDIA_DIR, thumbWebp))) out.thumbWebp = thumbWebp;
  return out;
}

/* Moves a verified quarantined upload into uploads/media under a fresh name. */
function store(file, prefix) {
  const ext = (path.extname(file.originalname || '') || '.jpg').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
  const name = prefix + rid(10) + ext;
  fs.renameSync(file.path, path.join(MEDIA_DIR, name));
  return name;
}
const discard = (file) => { if (file) { try { fs.unlinkSync(file.path); } catch (e) { /* already gone */ } } };

/* --- categories ----------------------------------------------------------- */
const getCategory = (id) => db.prepare('SELECT * FROM people_categories WHERE id=?').get(id);
const listCategories = () => db.prepare('SELECT * FROM people_categories ORDER BY sort_order, name').all().map(S.peopleCategory);
const listActiveCategories = () => db.prepare('SELECT * FROM people_categories WHERE active=1 ORDER BY sort_order, name').all().map(S.peopleCategory);

function createCategory(uid, b) {
  const name = v.str(b.name, 'Category name', { max: 80 });
  let id = String(b.id || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'cat-' + rid(4);
  if (getCategory(id)) id = id + '-' + rid(3);
  const order = b.order === undefined ? (db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM people_categories').get().n) : v.int(b.order, 'Order', { min: 0, max: 999 });
  runTx(() => db.prepare('INSERT INTO people_categories(id,name,sort_order,active,created) VALUES(?,?,?,?,?)').run(id, name, order, 1, Date.now()));
  audit(uid, 'people.category_create', 'people_category', id, { name, order });
  return S.peopleCategory(getCategory(id));
}

function updateCategory(uid, id, b) {
  const c = getCategory(id);
  if (!c) throw notFound('Category not found');
  const sets = [], args = [];
  if (b.name !== undefined) { sets.push('name=?'); args.push(v.str(b.name, 'Category name', { max: 80 })); }
  if (b.order !== undefined) { sets.push('sort_order=?'); args.push(v.int(b.order, 'Order', { min: 0, max: 999 })); }
  if (b.active !== undefined) { sets.push('active=?'); args.push(b.active ? 1 : 0); }
  if (!sets.length) throw bad('Nothing to update');
  runTx(() => db.prepare('UPDATE people_categories SET ' + sets.join(',') + ' WHERE id=?').run(...args, id));
  const after = getCategory(id);
  audit(uid, 'people.category_update', 'people_category', id, { from: { name: c.name, order: c.sort_order, active: c.active }, to: { name: after.name, order: after.sort_order, active: after.active } },
    { oldValue: { active: !!c.active }, newValue: { active: !!after.active } });
  return S.peopleCategory(after);
}

function deleteCategory(uid, id, reason) {
  const c = getCategory(id);
  if (!c) throw notFound('Category not found');
  const used = db.prepare('SELECT COUNT(*) c FROM people WHERE category_id=?').get(id).c;
  if (used) throw bad('People are still listed under this category. Move them first, or deactivate the category.');
  runTx(() => db.prepare('DELETE FROM people_categories WHERE id=?').run(id));
  audit(uid, 'people.category_delete', 'people_category', id, { name: c.name }, reason);
  return { ok: true };
}

/* Reorder by an explicit id list (admin drag/order save): listed ids get their
   index, everything else keeps its relative order after them. */
function reorderCategories(uid, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(String);
  if (!list.length) throw bad('Nothing to reorder');
  runTx(() => list.forEach((id, i) => db.prepare('UPDATE people_categories SET sort_order=? WHERE id=?').run(i + 1, id)));
  audit(uid, 'people.category_reorder', 'people_category', null, { order: list });
  return listCategories();
}

/* --- people --------------------------------------------------------------- */
const getId = (id) => db.prepare('SELECT * FROM people WHERE id=?').get(id);
const withCategory = (r) => r && Object.assign({}, r, { category_name: (getCategory(r.category_id) || {}).name || '' });
/* One admin-shaped person including the gallery, so write responses keep the
   admin Photos dialog accurate without a second round-trip. */
const row = (id) => {
  const r = getId(id);
  if (!r) return null;
  const photos = db.prepare('SELECT * FROM people_photos WHERE person_id=? ORDER BY sort_order, created').all(id).map(S.personPhoto);
  return Object.assign(S.person(withCategory(r), { admin: true }), { photos });
};

function cleanExpertise(x) {
  return (Array.isArray(x) ? x : []).map((s) => String(s).trim().slice(0, 80)).filter(Boolean).slice(0, 12);
}
function cleanSocials(x) {
  return (Array.isArray(x) ? x : []).map((s) => ({
    platform: String((s && s.platform) || '').trim().slice(0, 30),
    url: String((s && s.url) || '').trim().slice(0, 300)
  })).filter((s) => s.platform && /^https?:\/\//i.test(s.url)).slice(0, 8);
}
function cleanVideo(x) {
  const u = String(x || '').trim().slice(0, 300);
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) throw bad('Video link must start with http:// or https://');
  return u;
}
function categoryId(x) {
  const id = String(x || '').trim();
  if (!id) return null;
  if (!getCategory(id)) throw bad('Choose a valid category');
  return id;
}
const intField = (x, label) => v.int(x === '' || x === undefined || x === null ? 0 : x, label, { min: 0, max: 80 });

function createPerson(uid, b) {
  const name = v.str(b.name, 'Name', { max: 120 });
  const id = 'per' + rid(5);
  const now = Date.now();
  runTx(() => db.prepare(`INSERT INTO people(id,name,designation,category_id,city,country,experience,qualifications,
      expertise,intro,bio,background,sanatan_work,video_url,socials,sort_order,active,created,updated)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, name,
      v.str(b.designation, 'Designation', { max: 120, optional: true }),
      categoryId(b.categoryId),
      v.str(b.city, 'City', { max: 80, optional: true }),
      v.str(b.country, 'Country', { max: 80, optional: true }),
      intField(b.exp, 'Years of experience'),
      v.str(b.quals, 'Qualifications', { max: 300, optional: true }),
      JSON.stringify(cleanExpertise(b.expertise)),
      v.str(b.intro, 'Introduction', { max: 300, optional: true }),
      v.str(b.bio, 'Story', { max: 4000, optional: true }),
      v.str(b.background, 'Background', { max: 2000, optional: true }),
      v.str(b.sanatanWork, 'Sanatan work', { max: 2000, optional: true }),
      cleanVideo(b.video),
      JSON.stringify(cleanSocials(b.socials)),
      b.order === undefined ? 0 : v.int(b.order, 'Order', { min: 0, max: 999 }),
      b.active === undefined ? 1 : (b.active ? 1 : 0), now, now));
  audit(uid, 'people.create', 'person', id, { name, categoryId: b.categoryId || null });
  return row(id);
}

function updatePerson(uid, id, b) {
  const p = getId(id);
  if (!p) throw notFound('Person not found');
  const sets = [], args = [];
  const put = (col, val) => { sets.push(col + '=?'); args.push(val); };
  if (b.name !== undefined) put('name', v.str(b.name, 'Name', { max: 120 }));
  if (b.designation !== undefined) put('designation', v.str(b.designation, 'Designation', { max: 120, optional: true }));
  if (b.categoryId !== undefined) put('category_id', categoryId(b.categoryId));
  if (b.city !== undefined) put('city', v.str(b.city, 'City', { max: 80, optional: true }));
  if (b.country !== undefined) put('country', v.str(b.country, 'Country', { max: 80, optional: true }));
  if (b.exp !== undefined) put('experience', intField(b.exp, 'Years of experience'));
  if (b.quals !== undefined) put('qualifications', v.str(b.quals, 'Qualifications', { max: 300, optional: true }));
  if (b.expertise !== undefined) put('expertise', JSON.stringify(cleanExpertise(b.expertise)));
  if (b.intro !== undefined) put('intro', v.str(b.intro, 'Introduction', { max: 300, optional: true }));
  if (b.bio !== undefined) put('bio', v.str(b.bio, 'Story', { max: 4000, optional: true }));
  if (b.background !== undefined) put('background', v.str(b.background, 'Background', { max: 2000, optional: true }));
  if (b.sanatanWork !== undefined) put('sanatan_work', v.str(b.sanatanWork, 'Sanatan work', { max: 2000, optional: true }));
  if (b.video !== undefined) put('video_url', cleanVideo(b.video));
  if (b.socials !== undefined) put('socials', JSON.stringify(cleanSocials(b.socials)));
  if (b.order !== undefined) put('sort_order', v.int(b.order, 'Order', { min: 0, max: 999 }));
  if (b.active !== undefined) put('active', b.active ? 1 : 0);
  if (!sets.length) throw bad('Nothing to update');
  put('updated', Date.now());
  runTx(() => db.prepare('UPDATE people SET ' + sets.join(',') + ' WHERE id=?').run(...args, id));
  audit(uid, 'people.update', 'person', id, { from: { name: p.name, categoryId: p.category_id, active: p.active }, to: { name: b.name !== undefined ? b.name : p.name, categoryId: b.categoryId !== undefined ? b.categoryId : p.category_id, active: b.active !== undefined ? !!b.active : !!p.active } },
    { oldValue: { active: !!p.active }, newValue: { active: b.active !== undefined ? !!b.active : !!p.active } });
  return row(id);
}

function deletePerson(uid, id, reason) {
  const p = getId(id);
  if (!p) throw notFound('Person not found');
  const photos = db.prepare('SELECT * FROM people_photos WHERE person_id=?').all(id);
  runTx(() => {
    db.prepare('DELETE FROM people_photos WHERE person_id=?').run(id);
    db.prepare('DELETE FROM people WHERE id=?').run(id);
  });
  unlinkArtifacts([p.photo_file, p.photo_thumb, p.photo_webp, p.photo_thumb_webp].concat(photos.flatMap((x) => [x.filename, x.thumb, x.webp, x.thumb_webp])));
  audit(uid, 'people.delete', 'person', id, { name: p.name, photos: photos.length }, reason);
  return { ok: true };
}

/* --- photos --------------------------------------------------------------- */
function clearPhoto(uid, id, reason) {
  const p = getId(id);
  if (!p) throw notFound('Person not found');
  runTx(() => db.prepare('UPDATE people SET photo_file=NULL, photo_thumb=NULL, photo_webp=NULL, photo_thumb_webp=NULL, updated=? WHERE id=?').run(Date.now(), id));
  unlinkArtifacts([p.photo_file, p.photo_thumb, p.photo_webp, p.photo_thumb_webp]);
  audit(uid, 'people.photo_clear', 'person', id, {}, reason);
  return row(id);
}

async function setPhoto(uid, id, file) {
  const p = getId(id);
  if (!p) { discard(file); throw notFound('Person not found'); }
  if (!file) throw bad('Choose a photo to upload');
  if (file.mimetype === 'application/pdf') { discard(file); throw bad('Profile photo must be an image'); }
  const name = store(file, 'people-');
  const vt = await variants(name);
  runTx(() => db.prepare('UPDATE people SET photo_file=?, photo_thumb=?, photo_webp=?, photo_thumb_webp=?, updated=? WHERE id=?')
    .run(name, vt.thumb || null, vt.webp || null, vt.thumbWebp || null, Date.now(), id));
  unlinkArtifacts([p.photo_file, p.photo_thumb, p.photo_webp, p.photo_thumb_webp]);
  audit(uid, 'people.photo_set', 'person', id, { file: name });
  return row(id);
}

async function addGalleryPhoto(uid, id, file, caption) {
  const p = getId(id);
  if (!p) { discard(file); throw notFound('Person not found'); }
  if (!file) throw bad('Choose a photo to upload');
  if (file.mimetype === 'application/pdf') { discard(file); throw bad('Gallery photos must be images'); }
  const count = db.prepare('SELECT COUNT(*) c FROM people_photos WHERE person_id=?').get(id).c;
  if (count >= MAX_PHOTOS) { discard(file); throw bad('Photo limit reached for this profile'); }
  const name = store(file, 'peoplep-');
  const vt = await variants(name);
  const photoId = 'pp' + rid(5);
  const order = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM people_photos WHERE person_id=?').get(id).n;
  runTx(() => db.prepare('INSERT INTO people_photos(id,person_id,filename,thumb,webp,thumb_webp,caption,sort_order,created) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(photoId, id, name, vt.thumb || null, vt.webp || null, vt.thumbWebp || null, v.str(caption, 'Caption', { max: 200, optional: true }), order, Date.now()));
  audit(uid, 'people.photo_add', 'person', id, { photoId, file: name });
  return S.personPhoto(db.prepare('SELECT * FROM people_photos WHERE id=?').get(photoId));
}

function deleteGalleryPhoto(uid, photoId, reason) {
  const ph = db.prepare('SELECT * FROM people_photos WHERE id=?').get(photoId);
  if (!ph) throw notFound('Photo not found');
  runTx(() => db.prepare('DELETE FROM people_photos WHERE id=?').run(photoId));
  unlinkArtifacts([ph.filename, ph.thumb, ph.webp, ph.thumb_webp]);
  audit(uid, 'people.photo_delete', 'person', ph.person_id, { photoId }, reason);
  return { ok: true };
}

/* --- public reads --------------------------------------------------------- */
/* Admin listing: every person (inactive included) with the category name and
   their gallery (the admin Photos dialog manages it), in the category order
   then the admin-chosen order then name. */
function listAll() {
  const rows = db.prepare(`SELECT p.*, c.name category_name, c.sort_order cat_order FROM people p
      LEFT JOIN people_categories c ON c.id=p.category_id
      ORDER BY COALESCE(c.sort_order, 999), p.sort_order, p.name COLLATE NOCASE`).all();
  const photos = {};
  for (const ph of db.prepare('SELECT * FROM people_photos ORDER BY sort_order, created').all()) {
    (photos[ph.person_id] = photos[ph.person_id] || []).push(S.personPhoto(ph));
  }
  return rows.map((r) => Object.assign(S.person(r, { admin: true }), { photos: photos[r.id] || [] }));
}

/* Public listing: active people in active categories only, in the exact
   category order the admin arranged. */
function listActive() {
  return db.prepare(`SELECT p.* FROM people p JOIN people_categories c ON c.id=p.category_id
      WHERE p.active=1 AND c.active=1
      ORDER BY c.sort_order, p.sort_order, p.name COLLATE NOCASE`).all().map(S.personCard);
}

/* Public profile: same visibility rule as the listing; gallery photos ordered. */
function profile(id) {
  const p = db.prepare(`SELECT p.*, c.active cat_active FROM people p
      LEFT JOIN people_categories c ON c.id=p.category_id WHERE p.id=?`).get(String(id || ''));
  if (!p || !p.active || (p.category_id && !p.cat_active)) return null;
  const photos = db.prepare('SELECT * FROM people_photos WHERE person_id=? ORDER BY sort_order, created').all(p.id).map(S.personPhoto);
  return Object.assign(S.person(p), { photos });
}

module.exports = {
  getCategory, listCategories, listActiveCategories, createCategory, updateCategory, deleteCategory, reorderCategories,
  getId, listAll, listActive, profile, createPerson, updatePerson, deletePerson,
  setPhoto, clearPhoto, addGalleryPhoto, deleteGalleryPhoto, MAX_PHOTOS,
  /* exported for boot repair / tests */
  variants
};
