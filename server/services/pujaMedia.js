/* Puja photo/media management. One store, three consumers:
   - admin: full management (upload, approve/reject, publish/unpublish, primary, delete)
   - pandit: uploads photos ONLY for their own assigned bookings (server-verified
     ownership); uploads start in PENDING_ADMIN_REVIEW and are not public until the
     admin approves AND publishes. Pandits can delete their own pending uploads.
   - public/customers: only APPROVED + PUBLISHED photos ever leave the server.
   Files live in uploads/media (the existing upload dir); metadata in puja_media
   (migration 009). Downloads go through the API by media id — never by filename. */
'use strict';
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const upload = require('../lib/upload');
const variants = require('./mediaVariants');
const auditMod = require('../lib/audit');
const { bad, notFound, forbidden, rid } = require('../lib/util');

const mediaDir = upload.dirs.media;
const MAX_PHOTOS_PER_PUJA = 24;

const row = (id) => db.prepare('SELECT * FROM puja_media WHERE id=?').get(id);
const out = (r) => ({
  id: r.id, pujaId: r.puja_id, bookingId: r.booking_id || null, panditId: r.pandit_id || null,
  uploadedBy: r.uploaded_by || null, origName: r.orig_name || '', mime: r.mime, size: r.size,
  status: r.status, isPrimary: !!r.is_primary, isPublished: !!r.is_published,
  displayOrder: r.display_order, url: '/media/' + encodeURIComponent(r.filename), createdAt: r.created_at,
  /* metadata (migration 010 / PHOTO-MEDIA-SPEC.md) */
  source: r.source || (r.pandit_id ? 'pandit' : (String(r.filename || '').startsWith('seed-') ? 'seeded' : 'admin')),
  license: r.license || '', credit: r.credit || '', creator: r.creator || '', creditUrl: r.credit_url || '',
  altText: r.alt_text || '', category: r.category || 'puja',
  thumb: r.thumb ? '/media/' + encodeURIComponent(r.thumb) : '',
  /* WebP variants (migration 011); empty when not generated yet */
  webp: r.webp ? '/media/' + encodeURIComponent(r.webp) : '',
  thumbWebp: r.thumb_webp ? '/media/' + encodeURIComponent(r.thumb_webp) : '',
  rejectReason: r.reject_reason || ''
});

/* Public catalogue photos: approved AND published only, primary first.
   Pagination + optional category filter; returns shaped rows plus a page cursor. */
function publicForPuja(pujaId, { limit, offset, category } = {}) {
  const lim = Math.max(1, Math.min(48, parseInt(limit || 12, 10) || 12));
  const off = Math.max(0, parseInt(offset || 0, 10) || 0);
  const w = ["puja_id=?", "status='APPROVED'", "is_published=1"];
  const a = [pujaId];
  if (category && ['puja', 'ritual', 'temple', 'seva'].includes(String(category))) { w.push('category=?'); a.push(String(category)); }
  const rows = db.prepare(`SELECT * FROM puja_media WHERE ${w.join(' AND ')} ORDER BY is_primary DESC, display_order, created_at LIMIT ? OFFSET ?`).all(...a, lim + 1, off);
  const total = db.prepare(`SELECT COUNT(*) c FROM puja_media WHERE ${w.join(' AND ')}`).get(...a).c;
  return { photos: rows.slice(0, lim).map(out), total, limit: lim, offset: off, nextOffset: off + lim < total ? off + lim : null };
}

/* Admin list for one puja (everything) with optional status filter. */
const allForPuja = (pujaId, status) => {
  const rows = status && ['PENDING_ADMIN_REVIEW', 'APPROVED', 'REJECTED'].includes(String(status))
    ? db.prepare('SELECT * FROM puja_media WHERE puja_id=? AND status=? ORDER BY is_primary DESC, display_order, created_at').all(pujaId, status)
    : db.prepare('SELECT * FROM puja_media WHERE puja_id=? ORDER BY is_primary DESC, display_order, created_at').all(pujaId);
  return rows.map(out);
};
/* Pandit list: their own uploads (all states) + the approved/published set of their pujas. */
function mineForPandit(pid) {
  return db.prepare('SELECT * FROM puja_media WHERE pandit_id=? ORDER BY created_at DESC LIMIT 200').all(pid).map(out);
}

/* Admin moderation queue across all pujas, filterable by status and source. */
function adminList({ status, source, limit } = {}) {
  const w = [], a = [];
  if (status && ['PENDING_ADMIN_REVIEW', 'APPROVED', 'REJECTED'].includes(String(status))) { w.push('m.status=?'); a.push(String(status)); }
  if (source && ['seeded', 'admin', 'pandit'].includes(String(source))) { w.push('m.source=?'); a.push(String(source)); }
  const lim = Math.max(1, Math.min(500, parseInt(limit || 300, 10) || 300));
  const rows = db.prepare(`SELECT m.*, p.name puja_name, pd.name pandit_name FROM puja_media m
    LEFT JOIN pujas p ON p.id=m.puja_id LEFT JOIN pandits pd ON pd.id=m.pandit_id
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
    ORDER BY CASE m.status WHEN 'PENDING_ADMIN_REVIEW' THEN 0 ELSE 1 END, m.created_at DESC LIMIT ?`).all(...a, lim);
  return rows.map((r) => Object.assign(out(r), { pujaName: r.puja_name || '', panditName: r.pandit_name || '' }));
}

/* Bulk moderation for the admin UI. Returns per-id results. */
function bulk(uid, ids, op) {
  const results = [];
  for (const id of Array.isArray(ids) ? ids.slice(0, 200) : []) {
    try {
      if (op === 'delete') { results.push({ id, ok: remove({ uid, role: 'admin', pid: null, id }).ok }); continue; }
      const patch = op === 'approve' ? { status: 'APPROVED' }
        : op === 'reject' ? { status: 'REJECTED' }
        : op === 'publish' ? { published: true, status: 'APPROVED' }
        : op === 'unpublish' ? { published: false } : null;
      if (!patch) throw bad('Unknown bulk operation');
      moderate({ uid, id, status: patch.status, published: patch.published });
      results.push({ id, ok: true });
    } catch (e) { results.push({ id, ok: false, error: e.message }); }
  }
  return { results, changed: results.filter((r) => r.ok).length };
}

/* Full attribution list for the admin Credits view (and the credits report). */
function creditsList() {
  return db.prepare('SELECT m.*, p.name puja_name FROM puja_media m LEFT JOIN pujas p ON p.id=m.puja_id ORDER BY p.name, m.created_at').all()
    .map((r) => Object.assign(out(r), { pujaName: r.puja_name || '' }));
}

/* Pandit upload: booking must exist, belong to THIS pandit, and be a real assignment.
   Status is forced to PENDING_ADMIN_REVIEW — pandit uploads never publish directly.
   Alt text is required (spec); category defaults to 'seva'. */
function panditUpload({ pid, uid, bookingId, files, altText }) {
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(String(bookingId || ''));
  if (!b) throw notFound('Booking not found');
  if (b.pandit_id !== pid) throw forbidden('You can only upload photos for your own assigned bookings');
  const puja = db.prepare('SELECT id FROM pujas WHERE id=?').get(b.puja_id);
  if (!puja) throw notFound('Puja not found');
  const inserted = [];
  for (const f of files) {
    if (db.prepare('SELECT COUNT(*) c FROM puja_media WHERE puja_id=?').get(b.puja_id).c >= MAX_PHOTOS_PER_PUJA) {
      try { fs.unlinkSync(path.join(mediaDir, f.filename)); } catch (e) { /* already gone */ }
      continue;
    }
    const id = 'pm' + rid(5);
    const alt = String(altText || f.originalname || 'Puja photo').slice(0, 160);
    db.prepare(`INSERT INTO puja_media(id,puja_id,booking_id,pandit_id,uploaded_by,orig_name,filename,mime,size,status,is_primary,is_published,display_order,created_at,
                source,alt_text,category)
                VALUES(?,?,?,?,?,?,?,?,?, 'PENDING_ADMIN_REVIEW',0,0,0,?, 'pandit',?, 'seva')`)
      .run(id, b.puja_id, b.id, pid, uid || null, String(f.originalname || '').slice(0, 120), f.filename, f.mimetype, f.size, Date.now(), alt);
    inserted.push(row(id));
  }
  if (!inserted.length) throw bad('Photo limit reached for this puja');
  auditMod.audit(uid, 'media.pandit_upload', 'puja_media', inserted[0].id, { count: inserted.length, bookingId: b.id, pujaId: b.puja_id });
  return inserted.map(out);
}

/* Admin upload (direct to the catalogue). Admin media is trusted: APPROVED; published
   by default with an optional alt text and gallery category per the spec. */
function adminUpload({ uid, pujaId, files, makePrimary, altText, category, published = true }) {
  const puja = db.prepare('SELECT * FROM pujas WHERE id=?').get(String(pujaId || ''));
  if (!puja) throw notFound('Puja not found');
  const first = db.prepare('SELECT COUNT(*) c FROM puja_media WHERE puja_id=?').get(pujaId).c === 0;
  const inserted = [];
  for (const f of files) {
    if (db.prepare('SELECT COUNT(*) c FROM puja_media WHERE puja_id=?').get(pujaId).c >= MAX_PHOTOS_PER_PUJA) {
      try { fs.unlinkSync(path.join(mediaDir, f.filename)); } catch (e) { /* already gone */ }
      continue;
    }
    const id = 'pm' + rid(5);
    const primary = (makePrimary && inserted.length === 0) || (first && inserted.length === 0);
    const alt = String(altText || f.originalname || 'Puja photo').slice(0, 160);
    const cat = ['puja', 'ritual', 'temple', 'seva'].includes(String(category)) ? String(category) : 'puja';
    db.prepare(`INSERT INTO puja_media(id,puja_id,uploaded_by,orig_name,filename,mime,size,status,is_primary,is_published,display_order,created_at,
                source,alt_text,category)
                VALUES(?,?,?,?,?,?,?, 'APPROVED',?,?,0,?, 'admin',?,?)`)
      .run(id, pujaId, uid || null, String(f.originalname || '').slice(0, 120), f.filename, f.mimetype, f.size, primary ? 1 : 0, published ? 1 : 0, Date.now(), alt, cat);
    if (primary) db.prepare('UPDATE puja_media SET is_primary=0 WHERE puja_id=? AND id!=?').run(pujaId, id);
    inserted.push(row(id));
  }
  if (!inserted.length) throw bad('Photo limit reached for this puja');
  auditMod.audit(uid, 'media.admin_upload', 'puja_media', inserted[0].id, { count: inserted.length, pujaId });
  return inserted.map(out);
}

/* Moderation. Admin-only: approve/reject/publish/unpublish/primary/delete.
   reject_reason (migration 011) is stored when rejecting so pandits see why. */
function moderate({ uid, id, status, published, primary, rejectReason }) {
  const r = row(id);
  if (!r) throw notFound('Photo not found');
  const sets = [], args = [];
  if (status !== undefined) {
    const s = String(status);
    if (!['PENDING_ADMIN_REVIEW', 'APPROVED', 'REJECTED'].includes(s)) throw bad('Unknown status');
    sets.push('status=?'); args.push(s);
    if (s === 'REJECTED') {
      sets.push('is_published=0'); // rejected photos are never public
      sets.push('reject_reason=?'); args.push(String(rejectReason || 'Does not meet the photo guidelines').slice(0, 200));
    }
    if (s === 'APPROVED') { sets.push('reject_reason=\'\''); }
  }
  if (published !== undefined) {
    if (published && r.status !== 'APPROVED' && (status || r.status) !== 'APPROVED') throw bad('Only approved photos can be published');
    if (published && r.reject_reason) { sets.push("reject_reason=''"); }
    sets.push('is_published=?'); args.push(published ? 1 : 0);
  }
  if (primary) {
    db.prepare('UPDATE puja_media SET is_primary=0 WHERE puja_id=?').run(r.puja_id);
    sets.push('is_primary=1');
    if (published === undefined && r.status === 'APPROVED') { sets.push('is_published=1'); }
  }
  if (!sets.length) throw bad('Nothing to change');
  sets.push("updated_at=?"); args.push(Date.now());
  db.prepare('UPDATE puja_media SET ' + sets.join(', ') + ' WHERE id=?').run(...args, id);
  auditMod.audit(uid, 'media.moderate', 'puja_media', id, { status: status || r.status, published, primary: !!primary });
  return out(row(id));
}

/* Reorder: admin only. ids must cover photos of a single puja. */
function reorder(uid, ids) {
  if (!Array.isArray(ids) || !ids.length) throw bad('Nothing to reorder');
  const first = row(ids[0]);
  if (!first) throw notFound('Photo not found');
  ids.forEach((id, i) => {
    const r = row(id);
    if (r && r.puja_id === first.puja_id) db.prepare('UPDATE puja_media SET display_order=?, updated_at=? WHERE id=?').run(i, Date.now(), id);
  });
  auditMod.audit(uid, 'media.reorder', 'puja', first.puja_id, { count: ids.length });
  return allForPuja(first.puja_id);
}

/* Delete (file + row). Pandits may delete ONLY their own PENDING uploads.
   Every stored artifact is removed: original + JPEG thumb + full WebP + thumb
   WebP (migration 011). A clean DB row with orphaned variant files would slowly
   fill the Render disk — delete means delete. Variant names are taken from the
   row's columns; when a column is stale/empty (e.g. a crash mid-repair) the
   variant filename is derived from the stored original/thumb name instead. */
function remove({ uid, role, pid, id }) {
  const r = row(id);
  if (!r) throw notFound('Photo not found');
  if (role === 'pandit') {
    if (r.pandit_id !== pid) throw forbidden('You can only manage your own uploads');
    if (r.status !== 'PENDING_ADMIN_REVIEW') throw forbidden('Approved photos are managed by the admin');
  } else if (role !== 'admin') {
    throw forbidden('Not allowed');
  }
  const files = new Set();
  if (r.filename) files.add(path.basename(r.filename));
  if (r.thumb) files.add(path.basename(r.thumb));
  if (r.webp) files.add(path.basename(r.webp));
  if (r.thumb_webp) files.add(path.basename(r.thumb_webp));
  const base = path.basename(r.filename || '');
  if (base) {
    if (!r.webp) files.add(base.replace(/\.[a-z0-9]+$/i, '') + variants.WEBP_SUFFIX);
    if (!r.thumb_webp && r.thumb) files.add(path.basename(r.thumb).replace(/\.t320\.jpg$/i, '') + variants.THUMB_WEBP_SUFFIX);
  }
  for (const name of files) { try { fs.unlinkSync(path.join(mediaDir, name)); } catch (e) { /* already gone */ } }
  db.prepare('DELETE FROM puja_media WHERE id=?').run(id);
  auditMod.audit(uid, 'media.delete', 'puja_media', id, { pujaId: r.puja_id, by: role, files: files.size });
  return { ok: true };
}

/* Secure download: streams the file for a media id with role rules:
   - admin: any
   - pandit: own uploads
   - customer/anonymous: only APPROVED+PUBLISHED (public catalogue photos) */
function fileFor(id, auth) {
  const r = row(String(id || ''));
  if (!r) throw notFound('Photo not found');
  if (auth && auth.role === 'pandit' && r.pandit_id !== auth.pid && !(r.status === 'APPROVED' && r.is_published)) throw forbidden('Not allowed');
  if ((!auth || auth.role === 'customer') && !(r.status === 'APPROVED' && r.is_published)) throw notFound('Photo not found');
  const file = path.join(mediaDir, path.basename(r.filename)); // basename defeats any traversal
  if (!fs.existsSync(file)) throw notFound('File missing');
  return { file, mime: r.mime, name: r.orig_name || r.filename };
}

module.exports = { row, out, publicForPuja, allForPuja, mineForPandit, adminList, bulk, creditsList, panditUpload, adminUpload, moderate, reorder, remove, fileFor, MAX_PHOTOS_PER_PUJA };
