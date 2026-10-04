/* Phases 27-29 — Communication engine: ONE notification path with audience
   resolution, per-customer consent honouring and delivery records; a campaign
   lifecycle state machine (DRAFT → SCHEDULED → SENDING → SENT | FAILED, with
   CANCELLED from the not-yet-sent states); and a stateless Excel import with
   dedupe preview for customers and leads. Mirrors app/services/comms.py.

   Consent: users.pref carries { wa, sms, em } flags the customer controls in
   their account. The engine honours them: WhatsApp needs wa, SMS needs sms,
   Email needs em; Push/In-App are first-party. ON TOP of consent, pref.mute
   (item — per-customer notification preferences) can mute ONE channel or 'all'
   channels: every muted delivery is SKIPPED with that reason. A recipient
   without consent or without a contact target is SKIPPED with the reason, not
   silently dropped. WhatsApp rows additionally fire the provider adapter
   (services/whatsapp.js — stub behind env config) and record its answer in the
   delivery detail, so the campaign table shows what the adapter did. */
'use strict';
const { db, nextSeq } = require('../db');
const { v, bad, notFound, conflict } = require('../lib/util');

const CHANNELS = ['WhatsApp', 'Email', 'SMS', 'Push', 'In-App'];
const AUDIENCES = ['All customers', 'Repeat customers', 'Plus members', 'Flagged customers'];
const STATUSES = ['DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED'];
const IMPORT_KINDS = ['customers', 'leads'];

const nowMs = () => Date.now();

/* --- Delivery record ------------------------------------------------------ */
function recordDelivery({ campaignId = null, userId, channel, message, status, detail = null }) {
  const info = db.prepare(`INSERT INTO notification_deliveries(campaign_id,user_id,channel,message,status,detail,ts)
    VALUES(?,?,?,?,?,?,?)`).run(campaignId, userId, channel, message, status, detail, nowMs());
  return info.lastInsertRowid;
}

/* --- Audience resolution --------------------------------------------------- */
function audienceIds(audience) {
  if (audience === 'Repeat customers') {
    return db.prepare(`SELECT u.id FROM users u WHERE u.role='customer' AND (
      (SELECT COUNT(*) FROM bookings b WHERE b.user_id=u.id AND b.status NOT IN ('Cancelled','PendingPayment')) >= 2)`).all().map((r) => r.id);
  }
  if (audience === 'Plus members') return db.prepare("SELECT id FROM users WHERE role='customer' AND plus=1").all().map((r) => r.id);
  if (audience === 'Flagged customers') {
    const INC = require('./incidents');
    const ids = INC.flaggedCustomers().map((x) => x.customerId);
    return ids.length ? ids : [-1];
  }
  return db.prepare("SELECT id FROM users WHERE role='customer'").all().map((r) => r.id);
}

/* The ONE notification path: notifs row (the in-app store) + delivery record
   + provider fire exactly like notify(), plus consent honouring for customer
   channels. Returns the delivery status for this recipient. */
function deliver({ campaignId = null, userId, channel, message }) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!u) { recordDelivery({ campaignId, userId, channel, message, status: 'FAILED', detail: 'unknown user' }); return 'FAILED'; }
  const pref = (() => { try { return JSON.parse(u.pref || '{}'); } catch (e) { return {}; } })();
  /* Mute preference: the customer can mute ONE channel or ALL notifications.
     Absent pref.mute behaves exactly as before. */
  const mute = pref.mute;
  const mutedAll = mute === 'all';
  if (mutedAll || (Array.isArray(mute) && mute.some((c) => String(c).toLowerCase() === channel.toLowerCase()))) {
    recordDelivery({ campaignId, userId, channel, message, status: 'SKIPPED',
      detail: mutedAll ? 'customer muted all notifications' : 'customer muted ' + channel.toLowerCase() });
    return 'SKIPPED';
  }
  const hasTarget = (channel === 'WhatsApp' || channel === 'SMS') ? !!u.mobile
    : channel === 'Email' ? !!u.email : true;
  const consent = (channel === 'WhatsApp') ? pref.wa !== false
    : (channel === 'SMS') ? pref.sms !== false
    : (channel === 'Email') ? pref.em !== false : true;
  if (!hasTarget) {
    recordDelivery({ campaignId, userId, channel, message, status: 'SKIPPED', detail: 'no ' + channel.toLowerCase() + ' target' });
    return 'SKIPPED';
  }
  if (!consent) {
    recordDelivery({ campaignId, userId, channel, message, status: 'SKIPPED', detail: 'customer opted out of ' + channel.toLowerCase() });
    return 'SKIPPED';
  }
  db.prepare('INSERT INTO notifs(user_id,channel,message,ts) VALUES(?,?,?,?)').run(userId, channel, message, nowMs());
  const deliveryId = recordDelivery({ campaignId, userId, channel, message, status: 'SENT', detail: null });
  if (channel === 'WhatsApp') {
    /* Provider adapter (stub behind env config): its answer becomes the
       delivery record's detail — ops sees exactly what the adapter did. */
    const r = require('./whatsapp').send({ to: u.mobile, message, deliveryId });
    if (r) db.prepare('UPDATE notification_deliveries SET detail=? WHERE id=?').run(r, deliveryId);
  }
  return 'SENT';
}

/* Legacy notify() stays for system messages; campaigns use deliver(). */

/* --- Campaign lifecycle ----------------------------------------------------- */
const one = (id) => db.prepare('SELECT * FROM campaigns WHERE id=?').get(id);
const out = (c) => c && ({
  id: c.id, name: c.name, channel: c.channel, audience: c.audience, status: c.status, sent: c.sent || 0,
  message: c.message || '', scheduledAt: c.scheduled_at || null, createdBy: c.created_by || null,
  createdAt: c.created_at || null, sentAt: c.sent_at || null, failed: c.failed || 0
});

function create(body, actor) {
  const c = {
    id: 'C' + nextSeq('campaign_seq', 3),
    name: v.str(body.name, 'Name', { max: 80 }),
    channel: v.oneOf(body.channel, CHANNELS, 'Channel'),
    audience: v.oneOf(body.audience, AUDIENCES, 'Audience'),
    message: v.str(body.message || '', 'Message', { optional: true, max: 300 }),
    scheduled_at: null, created_by: actor, created_at: nowMs()
  };
  db.prepare(`INSERT INTO campaigns(id,name,channel,audience,status,sent,message,scheduled_at,created_by,created_at,sent_at,failed)
    VALUES(?,?,?,?, 'DRAFT',0,?,?,?, ?,NULL,0)`)
    .run(c.id, c.name, c.channel, c.audience, c.message, c.scheduled_at, c.created_by, c.created_at);
  require('../lib/audit').audit(actor, 'campaign.created', 'campaign', c.id, { name: c.name, channel: c.channel, audience: c.audience });
  return out(one(c.id));
}

function update(id, body, actor) {
  const c = one(id);
  if (!c) throw notFound('Campaign not found');
  if (c.status !== 'DRAFT') throw conflict('Only DRAFT campaigns can be edited');
  const name = body.name === undefined ? c.name : v.str(body.name, 'Name', { max: 80 });
  const channel = body.channel === undefined ? c.channel : v.oneOf(body.channel, CHANNELS, 'Channel');
  const audience = body.audience === undefined ? c.audience : v.oneOf(body.audience, AUDIENCES, 'Audience');
  const message = body.message === undefined ? c.message : v.str(body.message || '', 'Message', { optional: true, max: 300 });
  db.prepare('UPDATE campaigns SET name=?,channel=?,audience=?,message=? WHERE id=?').run(name, channel, audience, message, id);
  require('../lib/audit').audit(actor, 'campaign.updated', 'campaign', id, { name, channel, audience });
  return out(one(id));
}

function schedule(id, body, actor) {
  const c = one(id);
  if (!c) throw notFound('Campaign not found');
  if (c.status !== 'DRAFT') throw conflict('Only DRAFT campaigns can be scheduled');
  const msg = v.str((body && body.message) || c.message || '', 'Message', { max: 300 });
  const when = (body && body.scheduledAt) ? v.int(body.scheduledAt, 'Scheduled time', { min: nowMs() - 1000, max: nowMs() + 366 * 86400000 }) : nowMs();
  db.prepare("UPDATE campaigns SET status='SCHEDULED', message=?, scheduled_at=? WHERE id=?").run(msg, when, id);
  require('../lib/audit').audit(actor, 'campaign.scheduled', 'campaign', id, { when });
  return out(one(id));
}

function cancel(id, actor, reason) {
  const c = one(id);
  if (!c) throw notFound('Campaign not found');
  if (!['DRAFT', 'SCHEDULED'].includes(c.status)) throw conflict('Only not-yet-sent campaigns can be cancelled');
  db.prepare("UPDATE campaigns SET status='CANCELLED' WHERE id=?").run(id);
  require('../lib/audit').audit(actor, 'campaign.cancelled', 'campaign', id, { from: c.status }, reason);
  return out(one(id));
}

/* The send: DRAFT (send now) or SCHEDULED (due). Marks SENDING first so a
   crash mid-send is visible; per-recipient failures do not abort the send. */
function send(id, actor, reason) {
  const c = one(id);
  if (!c) throw notFound('Campaign not found');
  if (c.status === 'SENT' || c.status === 'FAILED' || c.status === 'CANCELLED') throw conflict('This campaign has already finished');
  if (c.status === 'SENDING') throw conflict('This campaign is already sending');
  const msg = v.str(c.message || '', 'Message', { max: 300 });
  const targets = audienceIds(c.audience);
  db.prepare("UPDATE campaigns SET status='SENDING' WHERE id=?").run(id);
  let sent = 0, failed = 0;
  for (const uid of targets) {
    const st = deliver({ campaignId: id, userId: String(uid), channel: c.channel, message: msg });
    if (st === 'SENT') sent++; else if (st === 'FAILED') failed++;
  }
  db.prepare("UPDATE campaigns SET status=?, sent=?, failed=?, sent_at=? WHERE id=?")
    .run(failed && !sent ? 'FAILED' : 'SENT', sent, failed, nowMs(), id);
  require('../lib/audit').audit(actor, 'campaign.sent', 'campaign', id, { audience: c.audience, sent, failed }, reason);
  return { ...out(one(id)), delivered: sent, skipped: targets.length - sent - failed };
}

function detail(id) {
  const c = one(id);
  if (!c) throw notFound('Campaign not found');
  const rows = db.prepare('SELECT status, COUNT(*) n FROM notification_deliveries WHERE campaign_id=? GROUP BY status').all(id);
  const d = { SENT: 0, SKIPPED: 0, FAILED: 0 };
  rows.forEach((r) => { d[r.status] = r.n; });
  const rec = db.prepare('SELECT user_id, channel, status, detail, ts FROM notification_deliveries WHERE campaign_id=? ORDER BY ts DESC LIMIT 500').all(id)
    .map((r) => ({ userId: r.user_id, channel: r.channel, status: r.status, detail: r.detail, ts: r.ts }));
  return { campaign: out(c), deliveries: d, rows: rec };
}

function list() {
  return db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC, id DESC').all().map(out);
}

/* --- Due-campaign sweep (boot-armed, like the other sweeps) -----------------
   Boot tick is the catch-up: a campaign scheduled while the server was down
   fires on the first boot after its scheduled_at. CAMPAIGN_SWEEP_MS env,
   default 60s; 0 disables. Tests drive dueSweep() directly. */
function dueSweep() {
  const due = db.prepare("SELECT id FROM campaigns WHERE status='SCHEDULED' AND scheduled_at<=?").all(nowMs());
  let sent = 0;
  for (const { id } of due) { try { send(id, null); sent++; } catch (e) { console.error('[campaigns]', e.message); } }
  return sent;
}
let sweepTimer = null;
function startSweeper() {
  if (sweepTimer) return sweepTimer;
  const raw = Number(process.env.CAMPAIGN_SWEEP_MS);
  const ms = raw > 0 ? raw : (raw === 0 ? 0 : 60000); /* 1m default */
  if (!ms) return null;
  try { dueSweep(); } catch (e) { console.error('[campaigns.sweeper]', e.message); }
  sweepTimer = setInterval(() => { try { dueSweep(); } catch (e) { console.error('[campaigns.sweeper]', e.message); } }, ms);
  sweepTimer.unref();
  return sweepTimer;
}
function stopSweeper() { if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; } }

/* --- Excel import with dedupe preview (stateless: preview then commit) ------ */
function importPreview(kind, rows) {
  if (!IMPORT_KINDS.includes(kind)) throw bad('Unknown import kind');
  const seen = new Map();
  const result = { total: 0, valid: 0, invalid: 0, willCreate: 0, willUpdate: 0, duplicatesInFile: 0, existing: 0, errors: [], preview: [] };
  for (const r of rows) {
    result.total++;
    const rowNo = result.total;
    if (kind === 'customers') {
      const name = String(r.name || '').trim(), mobile = String(r.mobile || '').trim().replace(/\D/g, '');
      const email = String(r.email || '').trim().toLowerCase();
      if (!name || name.length > 120) { result.invalid++; result.errors.push({ row: rowNo, error: 'name is required' }); continue; }
      if (!/^[6-9]\d{9}$/.test(mobile)) { result.invalid++; result.errors.push({ row: rowNo, error: 'a valid 10-digit mobile is required' }); continue; }
      const key = 'm:' + mobile;
      if (seen.has(key)) { result.duplicatesInFile++; result.errors.push({ row: rowNo, error: 'duplicate of row ' + seen.get(key) + ' in this file' }); continue; }
      seen.set(key, rowNo);
      const exist = db.prepare('SELECT id FROM users WHERE mobile=?').get(mobile);
      if (exist) { result.existing++; result.willUpdate++; result.preview.push({ row: rowNo, action: 'update', mobile, name }); }
      else { result.willCreate++; result.preview.push({ row: rowNo, action: 'create', mobile, name }); }
      result.valid++;
    } else {
      const name = String(r.name || '').trim(), mobile = String(r.mobile || '').trim().replace(/\D/g, '');
      const details = String(r.details || '').trim().slice(0, 800);
      const source = ['Contact', 'Corporate', 'Astrology', 'Kundli', 'Partner', 'Walk-in', 'Other'].includes(r.source) ? r.source : 'Other';
      if (!name) { result.invalid++; result.errors.push({ row: rowNo, error: 'name is required' }); continue; }
      if (mobile && !/^[6-9]\d{9}$/.test(mobile)) { result.invalid++; result.errors.push({ row: rowNo, error: 'invalid mobile' }); continue; }
      const key = mobile ? 'm:' + mobile : 'n:' + name.toLowerCase();
      if (seen.has(key)) { result.duplicatesInFile += 1; result.errors.push({ row: rowNo, error: 'duplicate of row ' + seen.get(key) + ' in this file' }); continue; }
      seen.set(key, rowNo);
      const exist = mobile ? db.prepare('SELECT id FROM leads WHERE mobile=?').get(mobile) : null;
      if (exist) { result.existing++; result.willUpdate++; result.preview.push({ row: rowNo, action: 'update', mobile, name, details, source }); }
      else { result.willCreate++; result.preview.push({ row: rowNo, action: 'create', mobile, name, details, source }); }
      result.valid++;
    }
  }
  return result;
}

function importCommit(kind, rows, actor, reason) {
  if (!IMPORT_KINDS.includes(kind)) throw bad('Unknown import kind');
  const pv = importPreview(kind, rows);
  if (!pv.willCreate && !pv.willUpdate) return { committed: 0, ...pv };
  let committed = 0;
  const tx = require('../db').tx;
  const run = tx(() => {
    for (const p of pv.preview) {
      if (p.action === 'create') {
        if (kind === 'customers') {
          db.prepare(`INSERT INTO users(id,role,name,mobile,pts,plus,pref,addr,fam,joined,created_at) VALUES(?,'customer',?,?,0,0,'{}','[]','[]',?,?)`)
            .run('u' + (nowMs() + committed), p.name, p.mobile, new Date().toISOString().slice(0, 10), nowMs());
        } else {
          require('./leads').capture({ type: p.source || 'Other', name: p.name, mobile: p.mobile, details: p.details }, actor);
        }
      } else if (kind === 'customers') {
        db.prepare('UPDATE users SET name=? WHERE mobile=?').run(p.name, p.mobile);
      } else {
        db.prepare('UPDATE leads SET name=? WHERE mobile=?').run(p.name, p.mobile);
      }
      committed++;
    }
  });
  run();
  require('../lib/audit').audit(actor, 'import.committed', kind, null, { committed, total: pv.total }, reason);
  return { committed, ...pv };
}

module.exports = { CHANNELS, AUDIENCES, STATUSES, IMPORT_KINDS, deliver, recordDelivery, audienceIds, create, update, schedule, cancel, send, detail, list, dueSweep, startSweeper, stopSweeper, importPreview, importCommit };
