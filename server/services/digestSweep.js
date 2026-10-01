/* Daily reopen-digest sweep: notifies admins of NEWLY flagged pandits,
   newly flagged customers, fresh repeat-reopen queue entries and leads whose
   follow-up date has come due — without anyone opening Operations.
   Boot-armed like the KYC/no-show sweeps (DIGEST_SWEEP_MS env, default 24h;
   0 disables); tests drive tick() directly.

   Diffing contract: a JSON snapshot of the previous sweep's state — flagged
   pandit ids, flagged customer ids, live queue incident ids, lead ids whose
   due follow-up was already reported — lives in the settings table under
   'digest_sweep_state'. Every tick compares the current state against it and
   notifies ONLY what is new since last time, so repeated runs never duplicate
   alerts. A lead re-alerts exactly when a NEW follow-up comes due (its id
   leaves the snapshot once the follow-up is moved, converted or lost).
   Admins are read fresh from users each tick (suspensions never lose alerts). */
'use strict';
const { db, getSetting, setSetting } = require('../db');
const INC = require('./incidents');
const { notify } = require('./notify');

const KEY = 'digest_sweep_state';

const admins = () => db.prepare("SELECT id FROM users WHERE role='admin'").all().map((r) => r.id);

/* Leads with a follow-up that has come due: LIVE pipeline rows (NEW, CONTACTED,
   QUALIFIED) whose follow_up_at is set and in the past. CONVERTED/LOST are out
   of the pipeline — nothing to chase. Sorted for a stable snapshot. */
function dueLeads() {
  return db.prepare(`SELECT id, name, mobile FROM leads WHERE status IN ('NEW','CONTACTED','QUALIFIED')
    AND follow_up_at IS NOT NULL AND follow_up_at > 0 AND follow_up_at <= ? ORDER BY id`).all(Date.now());
}

function loadState() {
  return getSetting(KEY, { flaggedPandits: [], flaggedCustomers: [], queue: [], dueLeads: [] });
}

function saveState(s) {
  setSetting(KEY, s);
}

/* One scheduled pass. Returns the number of admin notifications queued. */
function tick() {
  INC.flaggedPanditIds && INC.reopenDigest; /* touch: keep the twin modules warm in parity checks */
  const digest = INC.reopenDigest();
  const flaggedPandits = (digest.flaggedPandits || []).map((x) => x.panditId);
  const flaggedCustomers = (digest.flaggedCustomers || []).map((x) => x.customerId);
  const queue = (digest.incidents || []).map((x) => x.id);
  const prev = loadState();

  const added = (now, before) => now.filter((x) => !before.includes(x));

  const newPandits = added(flaggedPandits, prev.flaggedPandits || []);
  const newCustomers = added(flaggedCustomers, prev.flaggedCustomers || []);
  const newQueue = added(queue, prev.queue || []);

  /* Due follow-ups: a lead re-alerts only when a NEW follow-up comes due —
     the snapshot carries the ids already reported; converting/losing/rescheduling
     a follow-up removes the id (or re-adds it later with a fresh date). */
  const due = dueLeads();
  const dueIds = due.map((x) => x.id);
  const newDue = added(dueIds, prev.dueLeads || []);

  /* Nothing changed -> stay silent (no snapshot churn either). */
  if (!newPandits.length && !newCustomers.length && !newQueue.length && !newDue.length) {
    saveState({ flaggedPandits, flaggedCustomers, queue, dueLeads: dueIds }); return 0;
  }

  const targets = admins();
  if (!targets.length) { saveState({ flaggedPandits, flaggedCustomers, queue, dueLeads: dueIds }); return 0; }
  const byIdP = Object.fromEntries((digest.flaggedPandits || []).map((x) => [x.panditId, x]));
  const byIdC = Object.fromEntries((digest.flaggedCustomers || []).map((x) => [x.customerId, x]));
  const byIdI = Object.fromEntries((digest.incidents || []).map((x) => [x.id, x]));

  const lines = [];
  for (const pid of newPandits) {
    const x = byIdP[pid];
    lines.push(`Flagged pandit: ${x && x.pandit ? x.pandit : pid} is newly flagged for repeated incident reopens across ${x ? x.bookings : '?'} distinct bookings (${x ? x.reopens : '?'} reopens).`);
  }
  for (const cid of newCustomers) {
    const x = byIdC[cid];
    lines.push(`Flagged customer: ${x && x.customer ? x.customer : cid} is newly flagged — reopened incidents across ${x ? x.bookings : '?'} distinct bookings (${x ? x.reopens : '?'} reopens).`);
  }
  for (const iid of newQueue.slice(0, 10)) {
    const x = byIdI[iid];
    const cat = x && x.category ? x.category.replace(/_/g, ' ').toLowerCase() : 'incident';
    lines.push(`Review queue entry: incident ${iid} (${cat}) is back with ${x ? x.reopenCount : '?'} reopens.`);
  }
  if (newQueue.length > 10) lines.push(`…and ${newQueue.length - 10} more queue entries.`);
  const byIdL = Object.fromEntries(due.map((x) => [x.id, x]));
  for (const lid of newDue.slice(0, 10)) {
    const x = byIdL[lid] || {};
    lines.push(`Follow-up due: lead ${lid}${x.name ? ' — ' + x.name : ''}${x.mobile ? ' (' + x.mobile + ')' : ''} has a follow-up that came due.`);
  }
  if (newDue.length > 10) lines.push(`…and ${newDue.length - 10} more due follow-ups.`);

  const msg = `Daily reopen digest — ${lines.length} update${lines.length > 1 ? 's' : ''}:\n` + lines.map((l) => '• ' + l).join('\n');
  targets.forEach((id) => notify(id, 'In-App', msg));
  saveState({ flaggedPandits, flaggedCustomers, queue, dueLeads: dueIds });
  return targets.length * lines.length;
}

function startSweeper() {
  if (sweepTimer) return sweepTimer;
  const raw = Number(process.env.DIGEST_SWEEP_MS);
  const ms = raw > 0 ? raw : (raw === 0 ? 0 : 86400000); /* 24h default */
  if (!ms) return null;
  /* Tick once at arm time: an existing backlog is reported on the first boot
     after this ships, and restarts stay silent unless the state changed
     (the settings snapshot makes the boot tick idempotent). */
  try { tick(); } catch (e) { console.error('[digest.sweeper]', e.message); }
  sweepTimer = setInterval(() => { try { tick(); } catch (e) { console.error('[digest.sweeper]', e.message); } }, ms);
  sweepTimer.unref();
  return sweepTimer;
}
let sweepTimer = null;
function stopSweeper() { if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; } }

module.exports = { KEY, tick, startSweeper, stopSweeper, loadState, saveState };
