/* Social Media CMS (additional-requirements Phase C) — twin of
   backend-python/tests/test_socials.py.
   The footer's social icons are database rows, never hard-coded markup: the
   demo seeder adds Facebook/Instagram/YouTube plus one DISABLED international
   example, admins add/order/hide/delete through /admin/social-links, and only
   the active rows ever reach the public /state payload the footer renders. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-socials-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../server/db');
const seedMod = require('../server/seed');
const app = require('../server/index.js');

let server, base;
test.before(async () => {
  await seedMod.settledMedia();
  await new Promise((r) => { server = app.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; r(); }); });
});
test.after(() => { server.closeAllConnections(); server.close(); });

async function call(method, url, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(base + '/api' + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const admin = async () => (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
const customer = async () => (await call('POST', '/auth/email', { body: { email: 'social.probe@example.com', password: 'secret123', name: 'Social Probe' } })).json.token;

test('demo footer links ride /state in order; the disabled one stays admin-only', async () => {
  const anon = (await call('GET', '/state')).json;
  assert.deepEqual(anon.socials.map((s) => s.platform), ['facebook', 'instagram', 'youtube'], 'FB/IG/YT seeded active, in order');
  assert.equal(anon.socials[0].url, 'https://www.facebook.com/daivikpooja');
  assert.equal(anon.socials[0].icon, 'facebook', 'icon key points into the built-in SVG set');
  assert.ok(anon.socials.every((s) => s.active), 'the footer never receives a hidden row');

  const at = await admin();
  const st = (await call('GET', '/state', { token: at })).json;
  assert.equal(st.socialsAdmin.length, 4, 'admins see the disabled international example too');
  const disabled = st.socialsAdmin.find((s) => s.platform === 'linkedin');
  assert.equal(disabled.active, false);
  assert.ok(!st.socials.some((s) => s.platform === 'linkedin'));
});

test('admin CRUD: validation, updates, order and the audit trail', async () => {
  const at = await admin();
  const ct = await customer();
  assert.equal((await call('GET', '/admin/social-links', { token: ct })).status, 403);
  assert.equal((await call('POST', '/admin/social-links', { body: { platform: 'x', url: 'https://x.com/d' } })).status, 401);

  /* a URL without a scheme is refused before anything is written */
  const bad = await call('POST', '/admin/social-links', { token: at, body: { platform: 'whatsapp', url: 'whatsapp://chat' } });
  assert.equal(bad.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM social_links').get().c, 4, 'nothing was inserted');

  const made = await call('POST', '/admin/social-links', { token: at, body: { platform: 'WhatsApp', icon: 'whatsapp', url: 'https://wa.me/919999999999' } });
  assert.equal(made.status, 201);
  const s = made.json.link;
  assert.equal(s.platform, 'whatsapp', 'platform normalised to a key');
  assert.equal(s.order, 5, 'appends after the last row');
  assert.equal(s.active, true);

  const upd = await call('PATCH', '/admin/social-links/' + s.id, { token: at, body: { icon: 'made-up-glyph', order: 0, active: false } });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.link.icon, 'made-up-glyph', 'unknown icon keys round-trip (the FE falls back to the globe)');
  assert.equal(upd.json.link.active, false);
  const audit = db.prepare("SELECT * FROM audit_logs WHERE action='social.update' AND entity_id=?").get(s.id);
  assert.ok(audit, 'update audited');
  assert.equal(audit.old_value, '{"active":true}');
  assert.equal(audit.new_value, '{"active":false}');

  /* hide -> public state loses it, admin list keeps it; show round-trips */
  assert.ok(!(await call('GET', '/state')).json.socials.some((x) => x.id === s.id));
  assert.ok((await call('GET', '/state', { token: at })).json.socialsAdmin.some((x) => x.id === s.id));
  await call('PATCH', '/admin/social-links/' + s.id, { token: at, body: { active: true } });
  assert.ok((await call('GET', '/state')).json.socials.some((x) => x.id === s.id));

  /* reorder renumbers the footer from the given id list (real ids, or the row
     keeps its position — the endpoint never guesses by name) */
  const links = (await call('GET', '/admin/social-links', { token: at })).json.links;
  const idOf = (p) => links.find((x) => x.platform === p).id;
  const order = await call('POST', '/admin/social-links/order', { token: at, body: { ids: [s.id, idOf('facebook'), idOf('instagram'), idOf('youtube')] } });
  assert.equal(order.status, 200);
  assert.deepEqual(order.json.links.slice(0, 2).map((x) => x.id), [s.id, idOf('facebook')]);
  assert.deepEqual((await call('GET', '/state')).json.socials.map((x) => x.platform), ['whatsapp', 'facebook', 'instagram', 'youtube']);
});

test('delete is audited with a reason and the row disappears everywhere', async () => {
  const at = await admin();
  const s = (await call('GET', '/admin/social-links', { token: at })).json.links.find((x) => x.platform === 'whatsapp');
  assert.ok(s, 'the probe link from the CRUD test still exists');

  const del = await call('DELETE', '/admin/social-links/' + s.id, { token: at, body: { reason: 'probe cleanup' } });
  assert.equal(del.status, 200);
  assert.equal(del.json.ok, true);
  const audit = db.prepare("SELECT * FROM audit_logs WHERE action='social.delete' AND entity_id=?").get(s.id);
  assert.equal(audit.reason, 'probe cleanup');
  assert.ok(!(await call('GET', '/admin/social-links', { token: at })).json.links.some((x) => x.id === s.id));
  assert.equal((await call('DELETE', '/admin/social-links/' + s.id, { token: at, body: { reason: 'again' } })).status, 404);
});

test('reorder refuses an empty list; platform and URL stay validated on edit', async () => {
  const at = await admin();
  assert.equal((await call('POST', '/admin/social-links/order', { token: at, body: { ids: [] } })).status, 400);
  const fb = (await call('GET', '/admin/social-links', { token: at })).json.links.find((x) => x.platform === 'facebook');
  assert.equal((await call('PATCH', '/admin/social-links/' + fb.id, { token: at, body: { url: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await call('PATCH', '/admin/social-links/' + fb.id, { token: at, body: { platform: '' } })).status, 400);
  /* the row is untouched after both rejections */
  assert.equal((await call('GET', '/admin/social-links', { token: at })).json.links.find((x) => x.id === fb.id).url, 'https://www.facebook.com/daivikpooja');
});
