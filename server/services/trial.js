/* Trial poojas (master plan Phase 18) — activation assessments for pandits.
   Activates the migration-014 `trial_poojas` table (schema unchanged; models
   were already mirrored in both backends).

   Flow: an admin SCHEDULES a trial for a pandit (date + service), the pandit
   performs it, and the admin RECORDS the assessment. The 7 scoring dimensions
   are the same rubric as qa_records (punctuality, communication,
   ritual_compliance, presentation, customer_interaction, digital_capability,
   documentation) but a trial is all-or-nothing: every dimension must be scored
   1..5 (an activation decision must never rest on a partial picture).
   final_score = round(mean * 10) / 10.

   Result vocabulary (stored in trial_poojas.result):
     PENDING                scheduled, not yet assessed
     PASSED                 final_score >= passMark (setting 'trial_pass_mark',
                            default 3.5) — unlocks activation
     FAILED                 final_score < passMark — pandit must retrain and a
                            NEW trial is scheduled
     REASSESSMENT_REQUIRED  score qualified but the evaluator flagged issues;
                            a new trial is required (keeps the FAIL distinct
                            from a score-driven fail)

   Activation gate (Phase 18's whole point): an admin cannot flip a pandit to
   status='verified' until that pandit has a PASSED trial. KYC verified alone
   is no longer enough. `assertActivationAllowed` is consumed by the admin KYC
   route; the gate itself is audited. Existing verified pandits are grandfathered
   (the gate only fires on the transition into 'verified').

   Every write is audited with old→new values; the pandit is notified on every
   result. Admin CRUD lives in routes; the ledger/payout/KYC engines are
   untouched.
*/
'use strict';
const { db, tx, getSetting } = require('../db');
const { bad, notFound, conflict, rid, j } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('./notify');

const DIMENSIONS = ['punctuality', 'communication', 'ritual_compliance', 'presentation',
  'customer_interaction', 'digital_capability', 'documentation'];
const RESULTS = ['PENDING', 'PASSED', 'FAILED', 'REASSESSMENT_REQUIRED'];

const get = (id) => db.prepare('SELECT * FROM trial_poojas WHERE id=?').get(id);
const passMark = () => { const n = Number(getSetting('trial_pass_mark', 3.5)); return Number.isFinite(n) && n >= 1 && n <= 5 ? n : 3.5; };

const out = (r) => r && ({
  id: r.id, panditId: r.pandit_id, evaluator: r.evaluator, date: r.date, service: r.service,
  scores: {
    punctuality: r.punctuality, communication: r.communication, ritualCompliance: r.ritual_compliance,
    presentation: r.presentation, customerInteraction: r.customer_interaction,
    digitalCapability: r.digital_capability, documentation: r.documentation
  },
  finalScore: r.final_score, result: r.result, adminNotes: r.admin_notes || '', createdAt: r.created_at
});

/* Latest trial per pandit, oldest first within a pandit's history. */
function list() {
  return db.prepare('SELECT * FROM trial_poojas ORDER BY created_at DESC, id DESC').all().map(out);
}
function forPandit(panditId) {
  return db.prepare('SELECT * FROM trial_poojas WHERE pandit_id=? ORDER BY created_at DESC, id DESC').all(panditId).map(out);
}
function latest(panditId) {
  const r = db.prepare('SELECT * FROM trial_poojas WHERE pandit_id=? ORDER BY created_at DESC, id DESC').get(panditId);
  return out(r);
}

/* The gate: a pandit may be activated only with a PASSED (or already-grandfathered
   active) trial. Returns { ok, reason, trial } — routes turn !ok into a 409. */
function gateStatus(panditId) {
  const best = db.prepare(`SELECT * FROM trial_poojas WHERE pandit_id=? AND result='PASSED'
    ORDER BY created_at DESC, id DESC`).get(panditId);
  if (best) return { ok: true, reason: null, trial: out(best) };
  const any = latest(panditId);
  if (!any) return { ok: false, reason: 'No trial pooja has been assessed for this pandit yet — schedule one and record the result before activation.', trial: null };
  if (any.result === 'PENDING') return { ok: false, reason: 'The scheduled trial (' + any.id + ', ' + (any.date || 'unscheduled') + ') has not been assessed yet.', trial: any };
  return { ok: false, reason: 'The latest trial (' + any.id + ') ended ' + any.result + ' — schedule a new trial before activation.', trial: any };
}
function assertActivationAllowed(panditId) {
  const g = gateStatus(panditId);
  if (!g.ok) throw conflict(g.reason);
  return g.trial;
}

function schedule(actorUserId, { panditId, date, service, notes }) {
  const p = db.prepare('SELECT * FROM pandits WHERE id=?').get(panditId);
  if (!p) throw notFound('Pandit not found');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw bad('Trial date is required (YYYY-MM-DD)');
  const svc = String(service || '').trim();
  if (!svc) throw bad('Name the service the trial will cover (e.g. Satyanarayan Katha)');
  const id = 'TR' + rid(6);
  db.prepare(`INSERT INTO trial_poojas(id,pandit_id,evaluator,date,service,result,admin_notes,created_at)
    VALUES(?,?,?,?,?,'PENDING',?,?)`).run(id, panditId, actorUserId || null, date, svc.slice(0, 80),
    notes ? String(notes).slice(0, 500) : null, Date.now());
  audit(actorUserId, 'trial.scheduled', 'trial_pooja', id,
    { panditId, date, service: svc.slice(0, 80) },
    { newValue: { result: 'PENDING', date, service: svc.slice(0, 80) } });
  if (p.user_id) notify(p.user_id, 'In-App', `A trial puja has been scheduled for you on ${date} (${svc}).`);
  return out(get(id));
}

/* Record the assessment: ALL 7 dimensions required. Accepts both spellings
   (ritual_compliance / ritualCompliance) — the DB columns are snake_case, the
   SPA sends camelCase; an activation decision must never hinge on a key casing.
   Result is computed from the score against the pass mark unless the evaluator
   explicitly forces FAILED for cause (score alone does not capture it). */
const camel = (k) => k.replace(/_([a-z])/g, (m, c) => c.toUpperCase());
function record(actorUserId, id, { scores, notes, forceResult }) {
  const row = get(id);
  if (!row) throw notFound('Trial not found');
  if (row.result !== 'PENDING') throw conflict('Trial already assessed (' + row.result + ') — schedule a new one');
  const given = {};
  for (const k of DIMENSIONS) {
    const val = scores ? (scores[k] !== undefined ? scores[k] : scores[camel(k)]) : undefined;
    const n = Number(val);
    if (val === undefined || val === null || val === '') throw bad(k + ' is required for a trial assessment (all 7 dimensions, 1..5)');
    if (!Number.isInteger(n) || n < 1 || n > 5) throw bad(k + ' must be an integer 1..5');
    given[k] = n;
  }
  const mean = Object.values(given).reduce((s, n) => s + n, 0) / DIMENSIONS.length;
  const finalScore = Math.round(mean * 10) / 10;
  let result;
  if (forceResult === 'FAILED') result = 'FAILED';
  else if (forceResult === 'REASSESSMENT_REQUIRED') result = 'REASSESSMENT_REQUIRED';
  else result = finalScore >= passMark() ? 'PASSED' : 'FAILED';
  if (forceResult && !['FAILED', 'REASSESSMENT_REQUIRED'].includes(forceResult)) throw bad('forceResult may only be FAILED or REASSESSMENT_REQUIRED');
  if (result === 'REASSESSMENT_REQUIRED' && !notes) throw bad('Say what went wrong — a reassessment requires written feedback');
  tx(() => {
    db.prepare(`UPDATE trial_poojas SET evaluator=?, punctuality=?, communication=?, ritual_compliance=?,
      presentation=?, customer_interaction=?, digital_capability=?, documentation=?, final_score=?,
      result=?, admin_notes=? WHERE id=?`)
      .run(actorUserId || row.evaluator, given.punctuality, given.communication, given.ritual_compliance,
        given.presentation, given.customer_interaction, given.digital_capability, given.documentation,
        finalScore, result, notes ? String(notes).slice(0, 500) : row.admin_notes, id);
  })();
  audit(actorUserId, 'trial.recorded', 'trial_pooja', id,
    { panditId: row.pandit_id, scores: given, finalScore, result },
    { oldValue: { result: 'PENDING' }, newValue: { result, finalScore } });
  const p = db.prepare('SELECT user_id FROM pandits WHERE id=?').get(row.pandit_id);
  if (p && p.user_id) {
    const msg = result === 'PASSED' ? `Your trial puja was assessed: ${finalScore}/5 — PASSED. Your activation can now proceed.`
      : result === 'FAILED' ? `Your trial puja was assessed: ${finalScore}/5 — not passed. See the admin feedback and schedule a new trial.`
      : `Your trial puja was assessed: ${finalScore}/5 — a reassessment has been requested. See the admin feedback.`;
    notify(p.user_id, 'In-App', msg);
  }
  return out(get(id));
}

module.exports = { DIMENSIONS, RESULTS, get, list, forPandit, latest, gateStatus,
                   assertActivationAllowed, schedule, record, out, passMark };
