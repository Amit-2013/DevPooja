/* Our People CMS (additional-requirements Phase B) — twin of
   backend-python/tests/test_people.py.
   People and categories are database rows, never hard-coded pages: the nine
   categories are reference data, the Founder and Main Acharya are ordinary rows
   managed through the same admin CRUD, and every write is audited. Public reads
   only ever return active people in active categories; photo uploads are
   magic-byte verified before anything is written. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-people-'));
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

const jpeg = fs.readFileSync(path.join(__dirname, '..', 'shared', 'seed-photos', 'durga.jpg'));
async function call(method, url, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(base + '/api' + url, { method, headers, body: form ? form : body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const admin = async () => (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
const customer = async (email) => (await call('POST', '/auth/email', { body: { email, password: 'secret123', name: 'People Probe' } })).json.token;
const personBody = (o = {}) => ({
  name: 'Probe Person', designation: 'Acharya — Probe', categoryId: 'acharyas', city: 'Varanasi',
  country: 'India', exp: 12, quals: 'Shastri', expertise: ['Rudrabhishek', 'Vastu'], intro: 'Probe intro',
  bio: 'Probe story', background: 'Probe background', sanatanWork: 'Probe seva', order: 5, ...o
});
const create = (token, o) => call('POST', '/admin/people', { token, body: personBody(o) });
const uploadForm = (bytes, name, type, extra = {}) => {
  const fd = new FormData();
  fd.append('photo', new Blob([bytes], { type: type || 'image/jpeg' }), name || 'probe.jpg');
  Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
  return fd;
};

test('public directory lists seeded people in the exact category order', async () => {
  const r = await call('GET', '/people');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.categories.map((c) => c.id), ['founder', 'main-acharya', 'acharyas', 'vedic-scholars', 'jyotish-experts', 'pandits', 'temple-reps', 'advisors', 'team']);
  assert.ok(r.json.people.length >= 18, 'demo people seeded');
  const order = r.json.categories.map((c) => c.id);
  const seq = r.json.people.map((p) => p.categoryId);
  assert.deepEqual(seq, seq.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)), 'people grouped in category order');
  assert.ok(!r.json.people.some((p) => p.bio), 'listing is compact (no story payload)');

  const founder = (await call('GET', '/people/perfounder')).json.person;
  assert.equal(founder.n, 'Shri Devendra Shastri');
  assert.equal(founder.categoryId, 'founder');
  assert.ok(founder.bio.length > 200, 'the Founder story is real content');
  assert.deepEqual(founder.photos, []);
  const main = (await call('GET', '/people/peracharya')).json.person;
  assert.match(main.designation, /^Main Acharya/);
  assert.equal((await call('GET', '/people/nobody-here')).status, 404);
});

test('admin CRUD, visibility rules and audit trail', async () => {
  const at = await admin();
  const ct = await customer('people.probe@example.com');
  assert.equal((await call('GET', '/admin/people', { token: ct })).status, 403);
  assert.equal((await create(ct)).status, 403);
  assert.equal((await create('')).status, 401);

  const created = await create(at);
  assert.equal(created.status, 201);
  const p = created.json.person;
  assert.match(p.id, /^per/);
  assert.equal(p.active, 1);
  assert.equal(p.categoryName, 'Acharyas');
  assert.ok((await call('GET', '/people')).json.people.some((x) => x.id === p.id), 'active person is public');

  /* validation: bad category and bad video link are refused, junk socials dropped */
  assert.equal((await create(at, { categoryId: 'made-up' })).status, 400);
  assert.equal((await create(at, { video: 'javascript:alert(1)' })).status, 400);
  const badSocials = await create(at, { socials: [{ platform: 'x', url: 'ftp://nope' }, { platform: 'facebook', url: 'https://fb.com/probe' }] });
  assert.equal(badSocials.status, 201);
  assert.deepEqual(badSocials.json.person.socials.map((s) => s.platform), ['facebook']);

  const upd = await call('PATCH', '/admin/people/' + p.id, { token: at, body: { designation: 'Acharya — Updated', order: 1 } });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.person.designation, 'Acharya — Updated');

  /* deactivate: hidden from public list and profile, still visible to admins */
  const off = await call('PATCH', '/admin/people/' + p.id, { token: at, body: { active: false } });
  assert.equal(off.json.person.active, 0);
  assert.ok(!(await call('GET', '/people')).json.people.some((x) => x.id === p.id));
  assert.equal((await call('GET', '/people/' + p.id)).status, 404);
  assert.ok((await call('GET', '/admin/people', { token: at })).json.people.some((x) => x.id === p.id));

  const actions = db.prepare('SELECT action FROM audit_logs WHERE entity_id=?').all(p.id).map((r) => r.action);
  assert.ok(actions.includes('people.create') && actions.includes('people.update'));

  const del = await call('DELETE', '/admin/people/' + p.id, { token: at, body: { reason: 'test cleanup' } });
  assert.equal(del.status, 200);
  assert.ok(!(await call('GET', '/admin/people', { token: at })).json.people.some((x) => x.id === p.id));
  const audit = db.prepare("SELECT * FROM audit_logs WHERE action='people.delete' AND entity_id=?").get(p.id);
  assert.equal(audit.reason, 'test cleanup');
});

test('categories CRUD, order and delete guard', async () => {
  const at = await admin();
  assert.equal((await call('GET', '/admin/people-categories', { token: at })).json.categories.length, 9);

  const made = await call('POST', '/admin/people-categories', { token: at, body: { name: 'Guest Teachers' } });
  assert.equal(made.status, 201);
  const cid = made.json.category.id;
  assert.equal(made.json.category.order, 10);

  const renamed = await call('PATCH', '/admin/people-categories/' + cid, { token: at, body: { name: 'Guest Acharyas', order: 0 } });
  assert.equal(renamed.json.category.n, 'Guest Acharyas');
  assert.equal(renamed.json.category.order, 0);

  const order = await call('POST', '/admin/people-categories/order', { token: at, body: { ids: [cid, 'founder'] } });
  const ids = order.json.categories.map((c) => c.id);
  assert.equal(ids[0], cid);
  assert.equal(ids[1], 'founder');

  /* a category with people in it is protected; an empty one can go */
  assert.equal((await call('DELETE', '/admin/people-categories/acharyas', { token: at, body: { reason: 'probe' } })).status, 400);
  const empty = await call('DELETE', '/admin/people-categories/' + cid, { token: at, body: { reason: 'probe cleanup' } });
  assert.equal(empty.status, 200);
  assert.equal((await call('GET', '/admin/people-categories', { token: at })).json.categories[0].id, 'founder');

  const ct = await customer('people.cats@example.com');
  assert.equal((await call('GET', '/admin/people-categories', { token: ct })).status, 403);
});

test('photo upload generates variants; junk bytes are rejected; gallery add/delete', async () => {
  const at = await admin();
  const p = (await create(at, { name: 'Photo Probe' })).json.person;

  const up = await call('POST', '/admin/people/' + p.id + '/photo', { token: at, form: uploadForm(jpeg, 'probe.jpg', 'image/jpeg') });
  assert.equal(up.status, 200);
  const person = up.json.person;
  assert.match(person.photo, /^\/media\/people-/);
  assert.ok(person.photoThumb && person.photoThumbWebp, 'variants generated');
  assert.equal((await call('GET', '/people/' + p.id)).json.person.photo, person.photo);

  const fake = await call('POST', '/admin/people/' + p.id + '/photo', { token: at, form: uploadForm(Buffer.from('<html>not an image</html>'), 'evil.png', 'image/png') });
  assert.equal(fake.status, 400, 'content that does not match its type never touches the disk');

  const gal = await call('POST', '/admin/people/' + p.id + '/photos', { token: at, form: uploadForm(jpeg, 'g.jpg', 'image/jpeg', { caption: 'Probe gallery' }) });
  assert.equal(gal.status, 201);
  const photo = gal.json.photo;
  assert.match(photo.url, /^\/media\/peoplep-/);
  assert.equal(photo.caption, 'Probe gallery');
  assert.equal((await call('GET', '/people/' + p.id)).json.person.photos[0].id, photo.id);
  const adminRow = (await call('GET', '/admin/people', { token: at })).json.people.find((x) => x.id === p.id);
  assert.equal(adminRow.photos[0].id, photo.id, 'admin payload carries the gallery (drives the Photos dialog)');

  assert.equal((await call('DELETE', '/admin/people/photos/' + photo.id, { token: at, body: { reason: 'probe cleanup' } })).status, 200);
  assert.deepEqual((await call('GET', '/people/' + p.id)).json.person.photos, []);

  const cleared = await call('DELETE', '/admin/people/' + p.id + '/photo', { token: at, body: { reason: 'probe cleanup' } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.person.photo, '');
  assert.equal((await call('GET', '/people/' + p.id)).json.person.photo, '');

  /* admin state carries the CMS rows the portal renders from */
  const st = (await call('GET', '/state', { token: at })).json;
  assert.ok(st.peopleAdmin.length >= 18);
  assert.equal(st.peopleCatsAdmin.length, 9);
  assert.ok(st.peopleList.length >= 18 && !st.peopleList.some((x) => x.bio));
});
