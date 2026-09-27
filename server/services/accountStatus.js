/* Pandit account status lifecycle (master plan Phase 22) — one standardized
   system on the existing pandits row + users.status (009) login enforcement.

   Lifecycle vocabulary: ACTIVE (== pandit.status 'verified'), UNDER_REVIEW,
   SUSPENDED, TERMINATED. The onboarding states ('pending'/'rejected') are NOT
   lifecycle states and stay untouched.

   Effects:
     SUSPENDED  — login blocked (users.status='suspended'), future allocation
                  blocked (pandits.avail=0), open payouts held (Admin Hold with note)
     TERMINATED — same, plus users.status='disabled'; history and audit rows are
                  preserved (Phase 22: preserve agreement/audit history, data retention)
     UNDER_REVIEW — stays bookable but is flagged for admin follow-up
   Every transition writes reason + dates + review date (migration 015 columns)
   and an enriched audit record. Reinstatement (-> ACTIVE) clears the columns. */
'use strict';
const { db, tx } = require('../db');
const { bad, conflict, notFound } = require('../lib/util');
const { audit } = require('../lib/audit');
const PE = require('./payoutEngine');

const LIFECYCLE = ['ACTIVE', 'UNDER_REVIEW', 'SUSPENDED', 'TERMINATED'];
const REASONS = ['KYC Issue', 'Fraud Concern', 'Safety Concern', 'Serious Complaint',
  'Repeated Cancellation', 'Policy Violation', 'Other Documented Reason'];

const get = (pid) => db.prepare('SELECT * FROM pandits WHERE id=?').get(pid);

/* Maps lifecycle -> (pandits.status, users.status). Onboarding states untouched. */
function targets(lc) {
  if (lc === 'ACTIVE') return { pstatus: 'verified', ustatus: 'active', avail: 1 };
  if (lc === 'UNDER_REVIEW') return { pstatus: 'verified', ustatus: 'active', avail: 1 };
  if (lc === 'SUSPENDED') return { pstatus: 'verified', ustatus: 'suspended', avail: 0 };
  return { pstatus: 'verified', ustatus: 'disabled', avail: 0 }; // TERMINATED
}

function currentLifecycle(p) {
  if (p.status !== 'verified') return null; // onboarding state, not lifecycle
  if (p.account_reason && p.account_note === '__terminated__') return 'TERMINATED';
  if (p.account_reason || p.avail === 0) return 'SUSPENDED';
  return 'ACTIVE';
}

function transition(pid, lc, actorUserId, { reason, note, from, to, reviewDate } = {}) {
  const p = get(pid);
  if (!p) throw notFound('Pandit not found');
  if (!LIFECYCLE.includes(lc)) throw bad('Unknown lifecycle status');
  if (!REASONS.includes(reason) && lc !== 'ACTIVE' && lc !== 'UNDER_REVIEW') {
    throw bad('A documented reason is required (' + REASONS.slice(0, -1).join(', ') + ' or Other)');
  }
  const was = currentLifecycle(p);
  if (was === 'TERMINATED' && lc !== 'TERMINATED') throw conflict('A terminated pandit account cannot be reinstated');
  if (was === lc) throw conflict('Pandit is already ' + lc);
  const t = targets(lc);
  const u = db.prepare('SELECT id, status FROM users WHERE id=?').get(p.user_id);

  tx(() => {
    db.prepare(`UPDATE pandits SET status=?, avail=?, account_reason=?, account_from=?, account_to=?,
      account_review_date=?, account_note=? WHERE id=?`)
      .run(t.pstatus, t.avail,
           lc === 'ACTIVE' ? null : (reason || null),
           lc === 'ACTIVE' ? null : (from || new Date().toISOString().slice(0, 10)),
           lc === 'ACTIVE' ? null : (to || null),
           lc === 'ACTIVE' ? null : (reviewDate || null),
           lc === 'TERMINATED' ? '__terminated__' : (note || null), pid);
    if (u && t.ustatus && u.status !== t.ustatus) {
      db.prepare('UPDATE users SET status=? WHERE id=?').run(t.ustatus, u.id);
      audit(actorUserId, 'account.status', 'user', u.id,
        { from: u.status || 'active', to: t.ustatus, panditLifecycle: lc },
        { reason: reason || undefined });
    }
  })();

  /* Payout linkage: hold open payouts with the documented reason; release them
     (back to PENDING) on reinstatement. Legacy rows ('Pending'/'Paid', migration 012
     backfills only on the SQL path) are included via legacyStatus translation. */
  const payouts = db.prepare("SELECT id, status FROM payouts WHERE pandit_id=?").all(pid)
    .filter((po) => ['PENDING', 'ON_HOLD', 'PROCESSING'].includes(PE.legacyStatus(po.status)));
  for (const po of payouts) {
    if (lc === 'SUSPENDED' || lc === 'TERMINATED') {
      try { PE.transition(po.id, 'hold', actorUserId, { reason: 'Admin Hold', note: `Pandit ${lc}: ${reason}` }); } catch (e) { /* already held */ }
    } else if (lc === 'ACTIVE') {
      try { PE.transition(po.id, 'process', actorUserId, { reason: 'Pandit reinstated' }); } catch (e) { /* not holdable */ }
    }
  }

  audit(actorUserId, 'pandit.lifecycle', 'pandit', pid,
    { from: was || p.status, to: lc, ...(reason ? { reason } : {}), ...(reviewDate ? { reviewDate } : {}) },
    { reason: reason || undefined, oldValue: { lifecycle: was || p.status }, newValue: { lifecycle: lc } });
  return get(pid);
}

/* Admin screen rows: one pandit with lifecycle view + payout exposure. */
function overview() {
  return db.prepare('SELECT * FROM pandits ORDER BY name').all().map((p) => ({
    id: p.id, name: p.name, city: p.city, status: p.status,
    lifecycle: currentLifecycle(p), reason: p.account_reason || null,
    from: p.account_from || null, to: p.account_to || null,
    reviewDate: p.account_review_date || null, note: p.account_note === '__terminated__' ? null : p.account_note || null,
    openPayouts: db.prepare("SELECT COUNT(*) c FROM payouts WHERE pandit_id=? AND status IN ('PENDING','ON_HOLD','PROCESSING')").get(p.id).c
  }));
}

module.exports = { LIFECYCLE, REASONS, currentLifecycle, transition, overview, get };
