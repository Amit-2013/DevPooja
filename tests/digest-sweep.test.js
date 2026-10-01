/* Daily reopen-digest sweep — twin of backend-python/tests/test_digest_sweep.py.
   Verifies: the first sweep reports the current state to admins (so an existing
   backlog is surfaced even though nobody opened Operations); an immediate
   repeat is SILENT (snapshot diff); a new queue entry and a newly flagged
   pandit re-alert; the notifications panel surfaces digest lines. */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'test-secret';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-dsweep-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const test = require('node:test');
const assert = require('node:assert/strict');
const seedMod = require('../server/seed');
const app = require('../server/index.js');
const sweep = require('../server/services/digestSweep');
const { db } = require('../server/db');

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

const dismissReopen = async (at, id, tag, n) => {
  for (let i = 1; i <= n; i++) {
    await call('PATCH', '/admin/incidents/' + id, { token: at, body: { status: 'DISMISSED', reason: tag + ' dismissal ' + i } });
    await call('POST', '/admin/incidents/' + id + '/reopen', { token: at, body: { reason: tag + ' reopen ' + i } });
  }
};

test('digest sweep: baseline notify, silent repeat, new-entry re-alert, panel surfacing', async () => {
  const at = await admin(), ct = await login('customer'), pt = await login('pandit');

  /* Empty state: the very first tick on a fresh system stays quiet. */
  assert.equal(sweep.tick(), 0, 'no state -> no alerts');

  /* Build state: incidents across 3 distinct bookings flag p1 and fill the queue. */
  const mkBooking = async (day) => (await call('POST', '/bookings', { token: ct, body: { pujaId: 'satyanarayan', mode: 'home', date: dayPlus(day), slot: '10:00 AM', addr: { line: '12 Sweep Street', city: 'Delhi NCR', pin: '110001' }, panditId: 'p1', sam: [], pra: [] } })).json.booking;
  const inc = async (b, tag) => (await call('POST', '/pandit/incidents', { token: pt, body: { bookingId: b.id, category: 'CUSTOMER_CONDUCT', description: 'Sweep probe ' + tag + ': conduct dispute during the puja.' } })).json.incident;
  const b1 = await mkBooking(41), b2 = await mkBooking(42), b3 = await mkBooking(43);
  const i1 = await inc(b1, 'A'); await dismissReopen(at, i1.id, 'A', 3);
  const i2 = await inc(b2, 'B'); await dismissReopen(at, i2.id, 'B', 1);
  const i3 = await inc(b3, 'C'); await dismissReopen(at, i3.id, 'C', 1);

  /* First sweep WITH state: reports everything current (baseline). */
  const n1 = sweep.tick();
  assert.ok(n1 > 0, 'baseline sweep reports the current state to admins');
  const st1 = sweep.loadState();
  assert.ok(st1.flaggedPandits.includes('p1'), 'snapshot carries the flagged pandit');
  assert.ok(st1.queue.includes(i1.id), 'snapshot carries the queue entry');

  /* Immediate repeat: silent. */
  assert.equal(sweep.tick(), 0, 'repeat sweep with no change is silent');

  /* New queue entry (fresh reopen loop past the >2 threshold) re-alerts. */
  const b4 = await mkBooking(44);
  const i4 = await inc(b4, 'D'); await dismissReopen(at, i4.id, 'D', 3);
  const n2 = sweep.tick();
  assert.ok(n2 > 0, 'new queue entries re-alert');
  const st2 = sweep.loadState();
  assert.ok(st2.queue.includes(i4.id) && !st1.queue.includes(i4.id), 'snapshot advanced');
  assert.equal(sweep.tick(), 0, 'silent again after the diff is consumed');

  /* Ops panel surfaces the digest lines alongside queue-entry alerts. */
  const alerts = (await call('GET', '/admin/incidents/queue-alerts', { token: at })).json.alerts;
  assert.ok(alerts.some((a) => a.message.startsWith('Daily reopen digest — ')), 'digest lines reach the panel');
  assert.ok(alerts.some((a) => a.message.includes('Flagged pandit')), 'the digest names the newly flagged pandit');
  assert.ok(alerts.some((a) => a.message.includes('Review queue entry: incident ' + i4.id)), 'the digest names the new queue entry');

  /* Access: the panel stays admin-only. */
  assert.equal((await call('GET', '/admin/incidents/queue-alerts', { token: ct })).status, 403);
});

test('digest sweep: due lead follow-ups alert once, re-alert only on a new follow-up', async () => {
  const at = await admin();

  /* A lead with a past follow-up date is reported on the next tick. */
  const mk = async (name, mobile) => (await call('POST', '/admin/leads', { token: at, body: { source: 'Other', name, mobile } })).json.lead;
  const l1 = await mk('Due Follower', '9876511001');
  const dueAt = Date.now() - 3600e3;
  await db.prepare('UPDATE leads SET follow_up_at=? WHERE id=?').run(dueAt, l1.id);

  const n1 = sweep.tick();
  assert.ok(n1 > 0, 'a due follow-up is reported to admins');
  let st = sweep.loadState();
  assert.ok(st.dueLeads.includes(l1.id), 'snapshot carries the due lead');

  /* Immediate repeat: silent (already reported). */
  assert.equal(sweep.tick(), 0, 'repeat tick stays silent about the same follow-up');

  /* Rescheduling into the future clears the alert; coming due again re-alerts. */
  await db.prepare('UPDATE leads SET follow_up_at=? WHERE id=?').run(Date.now() + 86400e3, l1.id);
  assert.equal(sweep.tick(), 0, 'future follow-up is silent');
  st = sweep.loadState();
  assert.ok(!st.dueLeads.includes(l1.id), 'rescheduled lead left the due snapshot');
  await db.prepare('UPDATE leads SET follow_up_at=? WHERE id=?').run(Date.now() - 60e3, l1.id);
  assert.ok(sweep.tick() > 0, 're-due follow-up re-alerts');
  assert.equal(sweep.tick(), 0, 'silent again after the re-alert is consumed');

  /* The panel surfaces the follow-up line. */
  const alerts = (await call('GET', '/admin/incidents/queue-alerts', { token: at })).json.alerts;
  assert.ok(alerts.some((a) => a.message.includes('Follow-up due: lead ' + l1.id)), 'follow-up line reaches the notifications panel');

  /* Converting the lead takes it out of the pipeline — no more chasing. */
  await db.prepare("UPDATE leads SET status='CONVERTED' WHERE id=?").run(l1.id);
  assert.equal(sweep.tick(), 0, 'converted lead leaves the due set silently');
  st = sweep.loadState();
  assert.ok(!st.dueLeads.includes(l1.id), 'converted lead is out of the snapshot');
});
