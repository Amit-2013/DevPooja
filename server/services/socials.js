/* Social Media CMS (additional-requirements Phase C) — the single source of
   truth for the platform's social presence. Links are database rows, never
   hard-coded footer markup: an admin adds, orders, hides or deletes them and
   every write is audited. Production starts empty; the demo seeders add the
   sample Facebook/Instagram/YouTube rows (plus one disabled international
   example) only while DEMO_MODE is on.

   The `icon` column stores a KEY into the frontend's built-in inline SVG set
   (facebook, instagram, youtube, ...). The server never renders markup: an
   unknown key simply falls back to the generic globe icon in the footer, so a
   new platform can be added before its glyph exists. URLs are http/https only. */
'use strict';
const { db, tx } = require('../db');
const { bad, notFound, rid, v } = require('../lib/util');
const { audit } = require('../lib/audit');

const out = (r) => r && ({
  id: r.id, platform: r.platform, icon: r.icon || '', url: r.url,
  active: !!r.active, order: r.sort_order || 0, created: r.created
});

const get = (id) => db.prepare('SELECT * FROM social_links WHERE id=?').get(id);
/* Admin list: everything, in the order the footer draws it. */
const list = () => db.prepare('SELECT * FROM social_links ORDER BY sort_order, id').all().map(out);
/* Public list: active rows only (what /state hands the footer). */
const listActive = () => db.prepare('SELECT * FROM social_links WHERE active=1 ORDER BY sort_order, id').all().map(out);

function cleanUrl(x) {
  const u = v.str(x, 'URL', { max: 300 });
  if (!/^https?:\/\//i.test(u)) throw bad('URL must start with http:// or https://');
  return u;
}
const cleanKey = (x, name) => v.str(x, name, { max: 30, optional: true }).toLowerCase().replace(/[^a-z0-9-]/g, '');

function create(uid, b) {
  const platform = v.str(b.platform, 'Platform', { max: 40 }).toLowerCase().slice(0, 40);
  const url = cleanUrl(b.url);
  const icon = cleanKey(b.icon, 'Icon');
  const id = 'sl' + rid(4);
  const order = b.order === undefined ? (db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM social_links').get().n) : v.int(b.order, 'Order', { min: 0, max: 999 });
  tx(() => db.prepare('INSERT INTO social_links(id,platform,icon,url,active,sort_order,created) VALUES(?,?,?,?,?,?,?)')
    .run(id, platform, icon, url, b.active === undefined ? 1 : (b.active ? 1 : 0), order, Date.now()))();
  audit(uid, 'social.create', 'social_link', id, { platform, url, order });
  return out(get(id));
}

function update(uid, id, b) {
  const s = get(id);
  if (!s) throw notFound('Social link not found');
  const sets = [], args = [];
  if (b.platform !== undefined) { sets.push('platform=?'); args.push(v.str(b.platform, 'Platform', { max: 40 }).toLowerCase().slice(0, 40)); }
  if (b.url !== undefined) { sets.push('url=?'); args.push(cleanUrl(b.url)); }
  if (b.icon !== undefined) { sets.push('icon=?'); args.push(cleanKey(b.icon, 'Icon')); }
  if (b.order !== undefined) { sets.push('sort_order=?'); args.push(v.int(b.order, 'Order', { min: 0, max: 999 })); }
  if (b.active !== undefined) { sets.push('active=?'); args.push(b.active ? 1 : 0); }
  if (!sets.length) throw bad('Nothing to update');
  tx(() => db.prepare('UPDATE social_links SET ' + sets.join(',') + ' WHERE id=?').run(...args, id))();
  const after = get(id);
  audit(uid, 'social.update', 'social_link', id, { from: { platform: s.platform, active: s.active }, to: { platform: after.platform, active: after.active } },
    { oldValue: { active: !!s.active }, newValue: { active: !!after.active } });
  return out(after);
}

function remove(uid, id, reason) {
  const s = get(id);
  if (!s) throw notFound('Social link not found');
  tx(() => db.prepare('DELETE FROM social_links WHERE id=?').run(id))();
  audit(uid, 'social.delete', 'social_link', id, { platform: s.platform, url: s.url }, reason);
  return { ok: true };
}

/* Footer order: an explicit id list saves its index; links never carry data
   that anything else references, so this is a plain renumbering. */
function reorder(uid, ids) {
  const order = (Array.isArray(ids) ? ids : []).map(String);
  if (!order.length) throw bad('Nothing to reorder');
  tx(() => order.forEach((id, i) => db.prepare('UPDATE social_links SET sort_order=? WHERE id=?').run(i + 1, id)))();
  audit(uid, 'social.reorder', 'social_link', null, { order });
  return list();
}

module.exports = { get, list, listActive, create, update, remove, reorder, out };
