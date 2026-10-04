/* Phase 19: complaints workflow — ONE ticket state machine (server/services/tickets.js),
   mirrored by backend-python/tests/test_tickets.py: role-driven replies that move the
   status, explicit admin transitions with mandatory DECISION/RESOLVED notes, RESOLVED
   closed for replies, pandit scope limited to their own bookings, magic-checked evidence
   attachments filtered to /media/ urls, audits with old→new, and legacy 'Open'/'Resolved'
   rows normalising through the serializer.
   Harness parity with tests/incident.test.js. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-tickets-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const test = require('node:test');
const assert = require('node:assert/strict');
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
const login = async (role) => (await call('POST', '/auth/demo', { body: { role } })).json.token;
const admin = async () => (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
const dayPlus = (n) => { const d = new Date(); d.setHours(12); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const bookingBody = (o = {}) => ({ pujaId: 'satyanarayan', mode: 'home', date: dayPlus(20), slot: '10:00 AM', addr: { line: '12 Test Street', city: 'Delhi NCR', pin: '110001' }, panditId: 'p1', sam: [], pra: [], ...o });
/* A second customer (the demo login always resolves to u1). */
const otpCustomer = async (mobile) => {
  await call('POST', '/auth/otp/send', { body: { mobile } });
  return (await call('POST', '/auth/otp/verify', { body: { mobile, otp: '123456', name: 'Second Devotee' } })).json.token;
};

const { db } = require('../server/db');

/* Minimal magic-valid blobs for the media pipeline (images + video classes). */
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(24)]);
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(24)]);

const mkTicket = async (tok, o = {}) => {
  const r = await call('POST', '/tickets', { token: tok, body: { t: o.t || 'Pandit arrived 90 minutes late and the samagri packet was incomplete.', b: o.b || '' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
};

test('customer thread: create → detail → replies append while OPEN; owner scope hides other customers', async () => {
  const ct = await login('customer');
  const other = await otpCustomer('9810010001');
  const b = (await call('POST', '/bookings', { token: ct, body: bookingBody({ date: dayPlus(20) }) })).json.booking;
  const id = await mkTicket(ct, { b: b.id });

  const d = (await call('GET', '/tickets/' + id, { token: ct })).json;
  assert.equal(d.ticket.st, 'OPEN');
  assert.equal(d.ticket.b, b.id);
  assert.equal(d.ticket.prio, 'Medium');
  assert.ok(d.ticket.up, 'created_at-style updated_at stamped');
  assert.ok(d.ticket.next.includes('UNDER_REVIEW'), 'the FE renders the legal transition set');
  assert.ok(d.ticket.next.includes('RESOLVED'));
  assert.deepEqual(d.messages, []);

  /* a customer reply on OPEN just appends — triage has not started */
  const rep = await call('POST', '/tickets/' + id + '/replies', { token: ct, body: { message: 'I have the UPI receipt and the arrival time recorded.' } });
  assert.equal(rep.status, 200, JSON.stringify(rep.json));
  assert.equal(rep.json.ticket.st, 'OPEN', 'customer reply on OPEN does not move the status');
  assert.equal(rep.json.message.role, 'customer');
  assert.deepEqual(rep.json.message.attachments, []);
  const after = (await call('GET', '/tickets/' + id, { token: ct })).json;
  assert.equal(after.messages.length, 1);

  /* validation: empty and oversized messages are refused */
  assert.equal((await call('POST', '/tickets/' + id + '/replies', { token: ct, body: { message: '' } })).status, 400);
  assert.equal((await call('POST', '/tickets/' + id + '/replies', { token: ct, body: { message: 'x'.repeat(1001) } })).status, 400);
  assert.equal((await call('POST', '/tickets', { token: ct, body: { t: '' } })).status, 400, 'issue text required');
  assert.equal((await call('POST', '/tickets', { token: ct, body: { t: 'x', b: 'TKNOPE99' } })).status, 404, 'booking must be the caller’s own');

  /* another customer can neither read nor reply — 404, never a probe */
  assert.equal((await call('GET', '/tickets/' + id, { token: other })).status, 404);
  assert.equal((await call('POST', '/tickets/' + id + '/replies', { token: other, body: { message: 'sneaking in' } })).status, 404);
  assert.equal((await call('GET', '/tickets/' + id)).status, 401, 'anon refused');
});

test('admin transitions: legal matrix, DECISION/RESOLVED need notes, illegal → 409, audits old→new', async () => {
  const ct = await login('customer'), at = await admin();
  const id = await mkTicket(ct);

  assert.equal((await call('GET', '/admin/tickets/' + id, { token: at })).status, 200);
  assert.equal((await call('POST', '/admin/tickets/TKNOPE9/transition', { token: at, body: { status: 'UNDER_REVIEW' } })).status, 404);

  /* matrix guards */
  assert.equal((await call('POST', '/admin/tickets/' + id + '/transition', { token: at, body: { status: 'DECISION' } })).status, 409, 'OPEN → DECISION is illegal');
  assert.equal((await call('POST', '/admin/tickets/' + id + '/transition', { token: at, body: { status: 'OPEN' } })).status, 409, 'same status is a conflict');
  assert.equal((await call('POST', '/admin/tickets/' + id + '/transition', { token: at, body: { status: 'WEIRD' } })).status, 400);
  assert.equal((await call('POST', '/admin/tickets/' + id + '/transition', { token: at, body: {} })).status, 400, 'status required');

  /* note rules */
  assert.equal((await call('POST', '/admin/tickets/' + id + '/transition', { token: at, body: { status: 'RESOLVED' } })).status, 400, 'resolution required (legal target, no note)');

  const ur = await call('POST', '/admin/tickets/' + id + '/transition', { token: at, body: { status: 'UNDER_REVIEW' } });
  assert.equal(ur.status, 200, 'UNDER_REVIEW carries no note requirement');
  assert.equal(ur.json.ticket.st, 'UNDER_REVIEW');

  assert.equal((await call('POST', '/admin/tickets/' + id + '/transition', { token: at, body: { status: 'DECISION' } })).status, 400, 'decision note required');
  assert.equal((await call('POST', '/admin/tickets/' + id + '/transition', { token: at, body: { status: 'RESOLVED' } })).status, 400, 'resolution required');

  const dec = await call('POST', '/admin/tickets/' + id + '/transition', { token: at, body: { status: 'DECISION', note: 'Refund of 250 agreed; pandit briefed on the delay.' } });
  assert.equal(dec.status, 200, JSON.stringify(dec.json));
  assert.equal(dec.json.ticket.st, 'DECISION');
  assert.equal(dec.json.ticket.res, 'Refund of 250 agreed; pandit briefed on the delay.');
  const thread = (await call('GET', '/admin/tickets/' + id, { token: at })).json;
  assert.equal(thread.messages.length, 1, 'the note also lands in the thread');
  assert.equal(thread.messages[0].role, 'admin');
  assert.equal(thread.messages[0].message, 'Refund of 250 agreed; pandit briefed on the delay.');

  const res = await call('POST', '/admin/tickets/' + id + '/transition', { token: at, body: { status: 'RESOLVED' } });
  assert.equal(res.status, 400, 'DECISION → RESOLVED still needs the resolution');
  const done = await call('POST', '/admin/tickets/' + id + '/transition', { token: at, body: { status: 'RESOLVED', note: 'Refund issued against UPI reference R-77.' } });
  assert.equal(done.status, 200);
  assert.equal(done.json.ticket.st, 'RESOLVED');
  assert.equal(done.json.ticket.res, 'Refund issued against UPI reference R-77.');

  assert.equal((await call('POST', '/admin/tickets/' + id + '/transition', { token: at, body: { status: 'PANDIT_RESPONSE' } })).status, 409, 'RESOLVED only reopens through UNDER_REVIEW');
  const reopen = await call('POST', '/admin/tickets/' + id + '/transition', { token: at, body: { status: 'UNDER_REVIEW', note: 'Customer disputed the refund amount.' } });
  assert.equal(reopen.status, 200);
  assert.equal(reopen.json.ticket.st, 'UNDER_REVIEW');
  assert.equal(reopen.json.ticket.res, 'Refund issued against UPI reference R-77.', 'the resolution survives a reopen');

  /* audits: every hop with old→new (feed is newest-first) */
  const audits = (await call('GET', '/admin/audit?limit=300', { token: at })).json.entries;
  const hops = audits.filter((x) => x.action === 'ticket.transitioned' && x.entityId === id);
  assert.equal(hops.length, 4, 'OPEN→UNDER_REVIEW, →DECISION, →RESOLVED, →UNDER_REVIEW');
  assert.deepEqual(
    hops.map((h) => [h.oldValue, h.newValue]),
    [['RESOLVED', 'UNDER_REVIEW'], ['DECISION', 'RESOLVED'], ['UNDER_REVIEW', 'DECISION'], ['OPEN', 'UNDER_REVIEW']]);
  assert.equal(hops[0].role, 'admin');
  assert.equal(hops[1].reason, 'Refund issued against UPI reference R-77.', 'note recorded as the audit reason');
  assert.deepEqual(hops[3].detail, { from: 'OPEN', to: 'UNDER_REVIEW' });
});

test('replies move the status by role; RESOLVED refuses every reply with guidance', async () => {
  const ct = await login('customer'), pt = await login('pandit'), at = await admin();
  const b = (await call('POST', '/bookings', { token: ct, body: bookingBody({ date: dayPlus(22) }) })).json.booking;
  const id = await mkTicket(ct, { b: b.id });

  /* pandit answers an OPEN ticket → PANDIT_RESPONSE, audited as the pandit user */
  const p1 = await call('POST', '/pandit/tickets/' + id + '/replies', { token: pt, body: { message: 'Reached by 11:40; traffic on the bypass was the cause.' } });
  assert.equal(p1.status, 200, JSON.stringify(p1.json));
  assert.equal(p1.json.ticket.st, 'PANDIT_RESPONSE');
  /* follow-up on their own reply keeps the status */
  const p2 = await call('POST', '/pandit/tickets/' + id + '/replies', { token: pt, body: { message: 'Adding: the customer had not kept the samagri ready either.' } });
  assert.equal(p2.json.ticket.st, 'PANDIT_RESPONSE');
  /* customer answers back → CUSTOMER_RESPONSE */
  const c1 = await call('POST', '/tickets/' + id + '/replies', { token: ct, body: { message: 'The delay started before the agreed slot, sharing my timeline.' } });
  assert.equal(c1.json.ticket.st, 'CUSTOMER_RESPONSE');
  /* an admin note on a non-OPEN ticket does not move it */
  const a1 = await call('POST', '/admin/tickets/' + id + '/replies', { token: at, body: { message: 'Both sides heard; verifying the GPS log.' } });
  assert.equal(a1.json.ticket.st, 'CUSTOMER_RESPONSE');

  const audits = (await call('GET', '/admin/audit?limit=300', { token: at })).json.entries;
  const replied = audits.filter((x) => x.action === 'ticket.replied' && x.entityId === id);
  assert.equal(replied.length, 4);
  assert.equal(replied[2].role, 'pandit', 'actor is the pandit user id — role from the users row');
  assert.equal(replied[2].detail.status, 'PANDIT_RESPONSE');
  assert.equal(replied[2].detail.role, 'pandit');
  assert.equal(replied[0].detail.status, 'CUSTOMER_RESPONSE');

  /* DECISION locks the pandit out; the customer can still respond */
  await call('POST', '/admin/tickets/' + id + '/transition', { token: at, body: { status: 'PANDIT_RESPONSE' } });
  await call('POST', '/admin/tickets/' + id + '/transition', { token: at, body: { status: 'DECISION', note: 'Compensation of 200 credited to the customer.' } });
  const locked = await call('POST', '/pandit/tickets/' + id + '/replies', { token: pt, body: { message: 'But it was not our fault.' } });
  assert.equal(locked.status, 409, 'the admin is recording a decision');
  assert.match(locked.json.error, /recording a decision/);
  const custDec = await call('POST', '/tickets/' + id + '/replies', { token: ct, body: { message: 'Thanks — the credit has arrived.' } });
  assert.equal(custDec.json.ticket.st, 'CUSTOMER_RESPONSE', 'customer still answers during a decision');

  /* admin reply on an OPEN ticket starts the review (second ticket) */
  const id2 = await mkTicket(ct, { t: 'Duplicate complaint about the prasad delivery window.', b: b.id });
  const ar = await call('POST', '/admin/tickets/' + id2 + '/replies', { token: at, body: { message: 'Picking this up for triage.' } });
  assert.equal(ar.json.ticket.st, 'UNDER_REVIEW');

  /* /resolve compat alias: closes with its own note */
  const alias = await call('POST', '/admin/tickets/' + id2 + '/resolve', { token: at });
  assert.equal(alias.status, 200, JSON.stringify(alias.json));
  assert.equal(alias.json.ok, true);
  assert.equal(alias.json.ticket.st, 'RESOLVED');
  assert.equal(alias.json.ticket.res, 'Resolved by admin');

  /* RESOLVED is closed for business — everyone is refused with guidance */
  for (const [tok, url] of [[ct, '/tickets/' + id2 + '/replies'], [pt, '/pandit/tickets/' + id2 + '/replies'], [at, '/admin/tickets/' + id2 + '/replies']]) {
    const r = await call('POST', url, { token: tok, body: { message: 'One more thing…' } });
    assert.equal(r.status, 409, url);
    assert.match(r.json.error, /Raise a new ticket/);
  }
  const still = (await call('GET', '/admin/tickets/' + id2, { token: at })).json;
  assert.equal(still.messages.at(-1).message, 'Resolved by admin', 'no refused reply reached the thread');
});

test('evidence: magic-checked upload, replies keep only /media/ urls, max 8 attachments', async () => {
  const ct = await login('customer');
  const fd = new FormData();
  fd.append('evidence', new Blob([PNG], { type: 'image/png' }), 'one.png');
  fd.append('evidence', new Blob([MP4], { type: 'video/mp4' }), 'clip.mp4');
  const up = await fetch(base + '/api/tickets/evidence', { method: 'POST', headers: { Authorization: 'Bearer ' + ct }, body: fd });
  assert.equal(up.status, 200, await up.clone().text());
  const urls = (await up.json()).urls;
  assert.equal(urls.length, 2);
  assert.ok(urls.every((u) => u.startsWith('/media/')), 'urls served from the media dir');

  const bad = await fetch(base + '/api/tickets/evidence', { method: 'POST', headers: { Authorization: 'Bearer ' + ct }, body: (() => { const f2 = new FormData(); f2.append('evidence', new Blob([Buffer.from('definitely not an image')], { type: 'image/png' }), 'fake.png'); return f2; })() });
  assert.equal(bad.status, 400, 'magic check refuses mismatched content');
  const anon = await fetch(base + '/api/tickets/evidence', { method: 'POST', body: (() => { const f3 = new FormData(); f3.append('evidence', new Blob([PNG], { type: 'image/png' }), 'x.png'); return f3; })() });
  assert.equal(anon.status, 401, 'signed-in roles only');

  const id = await mkTicket(ct);
  const rep = await call('POST', '/tickets/' + id + '/replies', {
    token: ct,
    body: { message: 'Screenshots of the delay attached.', attachments: [...urls, 'http://evil.example/payload.png', '/etc/passwd'] }
  });
  assert.equal(rep.status, 200, JSON.stringify(rep.json));
  assert.deepEqual(rep.json.message.attachments, urls, 'foreign strings dropped, order preserved');

  /* attachments are capped at 8 regardless of what the client sends */
  const many = await call('POST', '/tickets/' + id + '/replies', {
    token: ct,
    body: { message: 'Nine files, only eight should stick.', attachments: Array.from({ length: 9 }, (_, i) => '/media/bulk' + i + '.png') }
  });
  assert.equal(many.json.message.attachments.length, 8);
  const filesOnDisk = fs.readdirSync(path.join(tmp, 'uploads', 'media'));
  assert.ok(filesOnDisk.length >= 2, 'files written under the upload dir');
});

test('pandit scope: only tickets attached to their own bookings, 404 otherwise', async () => {
  const ct = await login('customer'), pt = await login('pandit'), at = await admin();
  const mine = (await call('POST', '/bookings', { token: ct, body: bookingBody({ date: dayPlus(24) }) })).json.booking;
  const others = (await call('POST', '/bookings', { token: ct, body: bookingBody({ date: dayPlus(30), panditId: 'p2' }) })).json.booking;
  const own = await mkTicket(ct, { b: mine.id });
  const foreign = await mkTicket(ct, { b: others.id });
  const homeless = await mkTicket(ct, { t: 'Payment settled but no booking was ever linked to this complaint.' });

  const list = (await call('GET', '/pandit/tickets', { token: pt })).json.tickets;
  assert.ok(list.some((t) => t.id === own), 'own booking ticket listed');
  assert.ok(!list.some((t) => t.id === foreign), "another pandit's booking never listed");
  assert.ok(!list.some((t) => t.id === homeless), 'booking-less tickets are not the pandit’s');

  assert.equal((await call('GET', '/pandit/tickets/' + own, { token: pt })).status, 200);
  assert.equal((await call('GET', '/pandit/tickets/' + foreign, { token: pt })).status, 404);
  assert.equal((await call('GET', '/pandit/tickets/' + homeless, { token: pt })).status, 404);
  assert.equal((await call('POST', '/pandit/tickets/' + foreign + '/replies', { token: pt, body: { message: 'not mine' } })).status, 404);
  assert.equal((await call('POST', '/pandit/tickets/' + homeless + '/replies', { token: pt, body: { message: 'not mine either' } })).status, 404);
  const ok = await call('POST', '/pandit/tickets/' + own + '/replies', { token: pt, body: { message: 'On it — reaching out to the customer today.' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.ticket.st, 'PANDIT_RESPONSE');

  assert.equal((await call('GET', '/pandit/tickets', { token: ct })).status, 403, 'customers never enter the pandit portal');
});

test('access + legacy rows: admin-only, anon 401, "Open"/"Resolved" normalise', async () => {
  const ct = await login('customer'), pt = await login('pandit'), at = await admin();
  const id = await mkTicket(ct);
  const id2 = await mkTicket(ct, { t: 'Complaint migrated from the pre-workflow backlog.' });

  assert.equal((await call('GET', '/admin/tickets/' + id)).status, 401, 'anon refused');
  assert.equal((await call('GET', '/admin/tickets/' + id, { token: ct })).status, 403, 'customer refused');
  assert.equal((await call('GET', '/admin/tickets/' + id, { token: pt })).status, 403, 'pandit refused');
  assert.equal((await call('POST', '/admin/tickets/' + id + '/transition', { token: ct, body: { status: 'RESOLVED', note: 'x' } })).status, 403);

  /* pre-034 vocabulary normalises through norm() wherever it is read */
  db.prepare('UPDATE tickets SET status=? WHERE id=?').run('Open', id);
  const legacy = (await call('GET', '/admin/tickets/' + id, { token: at })).json;
  assert.equal(legacy.ticket.st, 'OPEN', "'Open' reads as OPEN");
  assert.equal((await call('POST', '/admin/tickets/' + id + '/transition', { token: at, body: { status: 'UNDER_REVIEW' } })).status, 200, 'the matrix works on legacy rows');
  const stateView = (await call('GET', '/tickets/' + id, { token: ct })).json;
  assert.equal(stateView.ticket.st, 'UNDER_REVIEW');

  db.prepare('UPDATE tickets SET status=? WHERE id=?').run('Resolved', id2);
  const legacy2 = (await call('GET', '/admin/tickets/' + id2, { token: at })).json;
  assert.equal(legacy2.ticket.st, 'RESOLVED', "'Resolved' reads as RESOLVED");
  assert.equal((await call('POST', '/tickets/' + id2 + '/replies', { token: ct, body: { message: 'still broken' } })).status, 409, 'legacy resolved tickets stay closed');
});
