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
const auditMod = require('../lib/audit');
const { bad, notFound, forbidden, rid } = require('../lib/util');

const mediaDir = upload.dirs.media;
const MAX_PHOTOS_PER_PUJA = 24;

const row = (id) => db.prepare('SELECT * FROM puja_media WHERE id=?').get(id);
const out = (r) => ({
  id: r.id, pujaId: r.puja_id, bookingId: r.booking_id || null, panditId: r.pandit_id || null,
  uploadedBy: r.uploaded_by || null, origName: r.orig_name || '', mime: r.mime, size: r.size,
  status: r.status, isPrimary: !!r.is_primary, isPublished: !!r.is_published,
  displayOrder: r.display_order, url: '/media/' + encodeURIComponent(r.filename), createdAt: r.created_at
});

/* Public catalogue photos: approved AND published only, primary first. */
function publicForPuja(pujaId) {
  return db.prepare("SELECT * FROM puja_media WHERE puja_id=? AND status='APPROVED' AND is_published=1 ORDER BY is_primary DESC, display_order, created_at").all(pujaId).map(out);
}

/* Admin list for one puja (everything). */
const allForPuja = (pujaId) => db.prepare('SELECT * FROM puja_media WHERE puja_id=? ORDER BY is_primary DESC, display_order, created_at').all(pujaId).map(out);
/* Pandit list: their own uploads (all states) + the approved/published set of their pujas. */
function mineForPandit(pid) {
  return db.prepare('SELECT * FROM puja_media WHERE pandit_id=? ORDER BY created_at DESC LIMIT 200').all(pid).map(out);
}

/* Pandit upload: booking must exist, belong to THIS pandit, and be a real assignment.
   Status is forced to PENDING_ADMIN_REVIEW — pandit uploads never publish directly. */
function panditUpload({ pid, uid, bookingId, files }) {
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
    db.prepare(`INSERT INTO puja_media(id,puja_id,booking_id,pandit_id,uploaded_by,orig_name,filename,mime,size,status,is_primary,is_published,display_order,created_at)
                VALUES(?,?,?,?,?,?,?,?,?, 'PENDING_ADMIN_REVIEW',0,0,0,?)`)
      .run(id, b.puja_id, b.id, pid, uid || null, String(f.originalname || '').slice(0, 120), f.filename, f.mimetype, f.size, Date.now());
    inserted.push(row(id));
  }
  if (!inserted.length) throw bad('Photo limit reached for this puja');
  auditMod.audit(uid, 'media.pandit_upload', 'puja_media', inserted[0].id, { count: inserted.length, bookingId: b.id, pujaId: b.puja_id });
  return inserted.map(out);
}

/* Admin upload (direct to the catalogue). Admin media is trusted: APPROVED + PUBLISHED. */
function adminUpload({ uid, pujaId, files, makePrimary }) {
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
    db.prepare(`INSERT INTO puja_media(id,puja_id,uploaded_by,orig_name,filename,mime,size,status,is_primary,is_published,display_order,created_at)
                VALUES(?,?,?,?,?,?,?, 'APPROVED',?,?,0,?)`)
      .run(id, pujaId, uid || null, String(f.originalname || '').slice(0, 120), f.filename, f.mimetype, f.size, primary ? 1 : 0, 1, Date.now());
    if (primary) db.prepare('UPDATE puja_media SET is_primary=0 WHERE puja_id=? AND id!=?').run(pujaId, id);
    inserted.push(row(id));
  }
  if (!inserted.length) throw bad('Photo limit reached for this puja');
  auditMod.audit(uid, 'media.admin_upload', 'puja_media', inserted[0].id, { count: inserted.length, pujaId });
  return inserted.map(out);
}

/* Moderation. Admin-only: approve/reject/publish/unpublish/primary/delete. */
function moderate({ uid, id, status, published, primary }) {
  const r = row(id);
  if (!r) throw notFound('Photo not found');
  const sets = [], args = [];
  if (status !== undefined) {
    const s = String(status);
    if (!['PENDING_ADMIN_REVIEW', 'APPROVED', 'REJECTED'].includes(s)) throw bad('Unknown status');
    sets.push('status=?'); args.push(s);
    if (s === 'REJECTED') { sets.push('is_published=0'); } // rejected photos are never public
    if (s !== 'APPROVED' && published === undefined) { sets.push('is_published=0'); }
  }
  if (published !== undefined) {
    if (published && r.status !== 'APPROVED' && (status || r.status) !== 'APPROVED') throw bad('Only approved photos can be published');
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

/* Delete (file + row). Pandits may delete ONLY their own PENDING uploads. */
function remove({ uid, role, pid, id }) {
  const r = row(id);
  if (!r) throw notFound('Photo not found');
  if (role === 'pandit') {
    if (r.pandit_id !== pid) throw forbidden('You can only manage your own uploads');
    if (r.status !== 'PENDING_ADMIN_REVIEW') throw forbidden('Approved photos are managed by the admin');
  } else if (role !== 'admin') {
    throw forbidden('Not allowed');
  }
  try { fs.unlinkSync(path.join(mediaDir, path.basename(r.filename))); } catch (e) { /* file may already be gone */ }
  db.prepare('DELETE FROM puja_media WHERE id=?').run(id);
  auditMod.audit(uid, 'media.delete', 'puja_media', id, { pujaId: r.puja_id, by: role });
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

module.exports = { row, out, publicForPuja, allForPuja, mineForPandit, panditUpload, adminUpload, moderate, reorder, remove, fileFor, MAX_PHOTOS_PER_PUJA };
