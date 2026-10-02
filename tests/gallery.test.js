/* Photo + Video Gallery (additional-requirements Phase D) — twin of
   backend-python/tests/test_gallery.py.
   Albums, photos and YouTube videos are database rows, never hard-coded
   content: the public gallery only ever sees active rows inside active albums,
   photo uploads are magic-byte verified before anything is written and keep
   their provenance, deleting an album never deletes its media, and every admin
   write is audited. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-gallery-'));
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
const customer = async (email) => (await call('POST', '/auth/email', { body: { email, password: 'secret123', name: 'Gallery Probe' } })).json.token;
const uploadForm = (bytes, name, type, extra = {}) => {
  const fd = new FormData();
  fd.append('photo', new Blob([bytes], { type: type || 'image/jpeg' }), name || 'probe.jpg');
  Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
  return fd;
};

test('public gallery: demo content, tabs, album filter and pagination', async () => {
  const r = await call('GET', '/gallery');
  assert.equal(r.status, 200);
  assert.equal(r.json.kind, 'photos');
  assert.equal(r.json.albums.length, 3, 'demo albums seeded');
  const fest = r.json.albums.find((a) => a.id === 'gal-festival');
  assert.ok(fest && fest.cover.startsWith('/media/'), 'album cover comes from its first photo');
  assert.ok(fest.coverThumb && fest.coverThumbWebp, 'cover carries its variants');
  assert.ok(fest.photos >= 3, 'album counts its photos');
  assert.ok(r.json.photos.length >= 1 && r.json.total >= r.json.photos.length);
  const p0 = r.json.photos[0];
  assert.ok(p0.url.startsWith('/media/gal-'), 'demo photos are copies of the bundled, licensed images');
  assert.ok(p0.license && p0.credit, 'provenance rides along with the copy');
  assert.ok(p0.altText, 'alt text is stored per photo');

  /* videos tab: the embed id and YouTube poster are derived from the URL */
  const v = await call('GET', '/gallery?kind=videos');
  assert.ok(v.json.videos.length >= 2, 'demo videos seeded');
  assert.match(v.json.videos[0].yt, /^[A-Za-z0-9_-]{6,20}$/);
  assert.match(v.json.videos[0].thumb, /^https:\/\/i\.ytimg\.com\/vi\//);

  /* albums tab returns only the album cards */
  const a = await call('GET', '/gallery?kind=albums');
  assert.equal(a.json.kind, 'albums');
  assert.equal(a.json.photos, undefined);
  assert.equal(a.json.albums.length, 3);

  /* album filter narrows the photos; unknown albums are refused */
  const f = await call('GET', '/gallery?album=gal-festival');
  assert.ok(f.json.photos.length > 0);
  assert.ok(f.json.photos.every((x) => x.albumId === 'gal-festival'));
  assert.equal((await call('GET', '/gallery?album=nope')).status, 400);

  /* pagination */
  const pg = await call('GET', '/gallery?limit=2');
  assert.equal(pg.json.photos.length, 2);
  assert.equal(pg.json.nextOffset, 2, 'nextOffset points at the next page');
  const pg2 = await call('GET', '/gallery?limit=2&offset=' + pg.json.nextOffset);
  assert.ok(pg2.json.photos.every((x) => !pg.json.photos.some((y) => y.id === x.id)), 'pages do not overlap');

  /* /state carries the public overview for every role, the admin rows only for admins */
  const anon = (await call('GET', '/state')).json;
  assert.equal(anon.gallery.albums.length, 3);
  assert.ok(anon.gallery.photos.length > 0 && anon.gallery.videos.length >= 2);
  assert.ok(anon.gallery.totalPhotos >= anon.gallery.photos.length);
  assert.deepEqual(anon.galleryAdmin, { albums: [], photos: [], videos: [] }, 'anonymous state never carries admin rows');
  const st = (await call('GET', '/state', { token: await admin() })).json;
  assert.ok(st.galleryAdmin.albums.length === 3 && st.galleryAdmin.photos.length >= 7 && st.galleryAdmin.videos.length >= 2);
});

test('album admin: CRUD, reorder and delete keeps the media', async () => {
  const at = await admin();
  const ct = await customer('gallery.albums@example.com');
  assert.equal((await call('GET', '/admin/gallery', { token: ct })).status, 403);
  assert.equal((await call('GET', '/admin/gallery')).status, 401);

  const made = await call('POST', '/admin/gallery/albums', { token: at, body: { name: 'Probe Album', description: 'Album for the probe' } });
  assert.equal(made.status, 201);
  const id = made.json.album.id;
  assert.match(id, /^alb/);
  assert.equal(made.json.album.order, 4, 'order defaults after the last album');
  assert.equal(made.json.album.active, 1);

  const upd = await call('PATCH', '/admin/gallery/albums/' + id, { token: at, body: { name: 'Renamed Album', active: false } });
  assert.equal(upd.json.album.n, 'Renamed Album');
  assert.equal(upd.json.album.active, 0);
  const hiddenPublic = await call('GET', '/gallery?kind=albums');
  assert.ok(!hiddenPublic.json.albums.some((a) => a.id === id), 'hidden albums never reach the public gallery');
  await call('PATCH', '/admin/gallery/albums/' + id, { token: at, body: { active: true } });

  const order = await call('POST', '/admin/gallery/albums/order', { token: at, body: { ids: [id, 'gal-festival'] } });
  assert.equal(order.json.albums[0].id, id);
  assert.equal(order.json.albums[1].id, 'gal-festival');

  /* deleting an album KEEPS its media: the photos become un-albumed and stay public */
  const before = (await call('GET', '/gallery?album=gal-behind')).json.photos;
  assert.ok(before.length >= 1, 'the demo album has photos to protect');
  const del = await call('DELETE', '/admin/gallery/albums/gal-behind', { token: at, body: { reason: 'probe cleanup' } });
  assert.equal(del.status, 200);
  assert.ok(del.json.photosKept >= 1, 'the photos are reported as kept, not destroyed');
  const orphans = (await call('GET', '/gallery?kind=photos&limit=48')).json.photos;
  assert.ok(orphans.some((p) => p.albumId === null && before.some((b) => b.id === p.id)), 'the album\'s photos survive, un-albumed');
  const audit = db.prepare("SELECT * FROM audit_logs WHERE action='gallery.album_delete' AND entity_id='gal-behind'").get();
  assert.equal(audit.reason, 'probe cleanup');

  assert.equal((await call('DELETE', '/admin/gallery/albums/nope', { token: at, body: { reason: 'x' } })).status, 404);
  const gone = await call('DELETE', '/admin/gallery/albums/' + id, { token: at, body: { reason: 'probe cleanup' } });
  assert.equal(gone.status, 200);
});

test('photo upload: variants, validation, visibility and audited delete', async () => {
  const at = await admin();
  const ct = await customer('gallery.photos@example.com');
  assert.equal((await call('POST', '/admin/gallery/photos', { token: ct, form: uploadForm(jpeg, 'p.jpg', 'image/jpeg') })).status, 403);

  const up = await call('POST', '/admin/gallery/photos', {
    token: at,
    form: uploadForm(jpeg, 'probe.jpg', 'image/jpeg', { caption: 'Probe caption', altText: 'Probe alt text', albumId: 'gal-festival' })
  });
  assert.equal(up.status, 201, up.json.error || '');
  const photo = up.json.photo;
  assert.match(photo.url, /^\/media\/galp-/);
  assert.ok(photo.thumb && photo.webp && photo.thumbWebp, 'thumb + WebP pair generated');
  assert.equal(photo.caption, 'Probe caption');
  assert.equal(photo.albumId, 'gal-festival');
  assert.equal(photo.active, 1);

  /* content that does not match its type never touches the disk */
  const fake = await call('POST', '/admin/gallery/photos', { token: at, form: uploadForm(Buffer.from('<html>not an image</html>'), 'evil.png', 'image/png') });
  assert.equal(fake.status, 400);
  /* a video file is not a gallery photo either */
  const vid = await call('POST', '/admin/gallery/photos', { token: at, form: uploadForm(Buffer.from('ftypmp42....'), 'clip.mp4', 'video/mp4') });
  assert.equal(vid.status, 400);
  /* a valid image but a made-up album is refused */
  assert.equal((await call('POST', '/admin/gallery/photos', { token: at, form: uploadForm(jpeg, 'p.jpg', 'image/jpeg', { albumId: 'nope' }) })).status, 400);

  /* public reads: present while active, gone when hidden, back when restored */
  assert.ok((await call('GET', '/gallery?album=gal-festival&limit=48')).json.photos.some((p) => p.id === photo.id));
  await call('PATCH', '/admin/gallery/photos/' + photo.id, { token: at, body: { caption: 'Renamed caption', active: false } });
  assert.ok(!(await call('GET', '/gallery?album=gal-festival&limit=48')).json.photos.some((p) => p.id === photo.id));
  assert.ok((await call('GET', '/admin/gallery', { token: at })).json.photos.some((p) => p.id === photo.id), 'admins still see hidden rows');
  await call('PATCH', '/admin/gallery/photos/' + photo.id, { token: at, body: { active: true, albumId: '' } });
  assert.equal((await call('GET', '/gallery?limit=48')).json.photos.find((p) => p.id === photo.id).caption, 'Renamed caption');

  /* the delete removes the stored artifacts and is audited with a reason */
  const stored = path.join(process.env.UPLOAD_DIR, 'media', path.basename(photo.url));
  assert.ok(fs.existsSync(stored), 'the original was written to the media dir');
  const del = await call('DELETE', '/admin/gallery/photos/' + photo.id, { token: at, body: { reason: 'probe cleanup' } });
  assert.equal(del.status, 200);
  assert.ok(!fs.existsSync(stored), 'the stored original is removed with the row');
  assert.equal((await call('GET', '/admin/gallery', { token: at })).json.photos.some((p) => p.id === photo.id), false);
  const audit = db.prepare("SELECT * FROM audit_logs WHERE action='gallery.photo_delete' AND entity_id=?").get(photo.id);
  assert.equal(audit.reason, 'probe cleanup');
  assert.ok(db.prepare('SELECT 1 FROM audit_logs WHERE action=? AND entity_id=?').get('gallery.photo_add', photo.id), 'uploads are audited too');
});

test('video admin: URL validation, embed id, visibility and audit trail', async () => {
  const at = await admin();
  const ct = await customer('gallery.videos@example.com');
  assert.equal((await call('POST', '/admin/gallery/videos', { token: ct, body: { title: 'X', url: 'https://youtu.be/abc12345' } })).status, 403);

  assert.equal((await call('POST', '/admin/gallery/videos', { token: at, body: { title: 'Bad link', url: 'ftp://nope' } })).status, 400);
  assert.equal((await call('POST', '/admin/gallery/videos', { token: at, body: { title: 'No link' } })).status, 400);
  assert.equal((await call('POST', '/admin/gallery/videos', { token: at, body: { url: 'https://youtu.be/abc12345' } })).status, 400, 'a title is required');

  const made = await call('POST', '/admin/gallery/videos', { token: at, body: { title: 'Probe video', description: 'Probe', url: 'https://www.youtube.com/watch?v=jTNu-R9KA-4', albumId: 'gal-festival' } });
  assert.equal(made.status, 201);
  const vidRow = made.json.video;
  assert.equal(vidRow.yt, 'jTNu-R9KA-4', 'the embed id is derived from the URL');
  assert.match(vidRow.thumb, /^https:\/\/i\.ytimg\.com\/vi\/jTNu-R9KA-4\//);
  assert.equal(vidRow.active, 1);
  assert.ok((await call('GET', '/gallery?kind=videos&limit=48')).json.videos.some((v) => v.id === vidRow.id));

  /* hidden videos leave the public tab but stay manageable */
  await call('PATCH', '/admin/gallery/videos/' + vidRow.id, { token: at, body: { active: false } });
  assert.ok(!(await call('GET', '/gallery?kind=videos&limit=48')).json.videos.some((v) => v.id === vidRow.id));
  await call('PATCH', '/admin/gallery/videos/' + vidRow.id, { token: at, body: { active: true, title: 'Renamed video' } });
  assert.equal((await call('GET', '/gallery?kind=videos&limit=48')).json.videos.find((v) => v.id === vidRow.id).n, 'Renamed video');

  /* reorder */
  const order = await call('POST', '/admin/gallery/videos/order', { token: at, body: { ids: [vidRow.id] } });
  assert.equal(order.status, 200);

  const del = await call('DELETE', '/admin/gallery/videos/' + vidRow.id, { token: at, body: { reason: 'probe cleanup' } });
  assert.equal(del.status, 200);
  const actions = db.prepare('SELECT action FROM audit_logs WHERE entity_id=?').all(vidRow.id).map((r) => r.action);
  assert.ok(actions.includes('gallery.video_create') && actions.includes('gallery.video_update') && actions.includes('gallery.video_delete'));
  const audit = db.prepare("SELECT * FROM audit_logs WHERE action='gallery.video_delete' AND entity_id=?").get(vidRow.id);
  assert.equal(audit.reason, 'probe cleanup');
});
