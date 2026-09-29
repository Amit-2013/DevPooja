/* Typed money ledger (master plan Phase 10) + the effective-dated commission
   tier resolver (Phase 9), activating the migration-014 `transactions` and
   `commission_tiers` tables. Every rupee movement in the platform gets ONE
   ledger row with a type, actor and source ref:

     SERVICE_PAYMENT  customer paid for a puja booking (payment confirmed)
     KUNDALI_PAYMENT  customer paid for a commercial kundali (payment confirmed)
     DAKSHINA         voluntary offering recorded at booking time
     REFUND           money returned to a customer (cancellation)
     COMMISSION       platform share realized on a payout transition to DISBURSED
     PAYOUT           pandit disbursement (money leaves the platform)

   Rules:
   - dedupe: `dedupe` upserts on (ref_table, ref_id, type) so retrying a payment
     confirmation or re-running a transition never double-counts.
   - amounts are signed from the platform's perspective: SERVICE_PAYMENT /
     KUNDALI_PAYMENT / DAKSHINA / COMMISSION are inflows (+), REFUND / PAYOUT
     are outflows (-). The Dakshina report and admin views read sign+type.
   - commission tiers (Phase 9): resolveTier(panditId, category, date) returns
     the active tier row whose effective window covers the date, most specific
     category first, newest effective_from first; null = use the settings
     fallback ('commission' setting). The payout engine consults this on every
     createForBooking; admin CRUD + audit live in routes.
*/
'use strict';
const { db, tx, getSetting } = require('../db');
const { bad } = require('../lib/util');
const { audit } = require('../lib/audit');

const TYPES = ['SERVICE_PAYMENT', 'KUNDALI_PAYMENT', 'NRI_PAYMENT', 'DAKSHINA', 'REFUND', 'COMMISSION', 'PAYOUT'];

/* One ledger row. Signed amount expected (call sites pass the sign). */
function record({ type, amount, userId, panditId, bookingId, kundaliId, refTable, refId, note }) {
  if (!TYPES.includes(type)) throw bad('Unknown ledger type: ' + type);
  const amt = Math.round(Number(amount) || 0);
  if (!amt) throw bad('Ledger amount must be non-zero');
  const info = tx(() => db.prepare(`INSERT INTO transactions(type,user_id,pandit_id,booking_id,kundali_id,
    amount,currency,ref_table,ref_id,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(type, userId || null, panditId || null, bookingId || null, kundaliId || null,
      amt, 'INR', refTable || null, refId || null, note ? String(note).slice(0, 200) : null,
      Date.now()))();
  return { id: info.lastInsertRowid };
}

/* Idempotent variant for payment/transition paths: one row per (ref_table, ref_id, type). */
function dedupe({ type, amount, userId, panditId, bookingId, kundaliId, refTable, refId, note }) {
  const existing = db.prepare('SELECT id FROM transactions WHERE type=? AND ref_table=? AND ref_id=?')
    .get(type, refTable || null, refId || null);
  if (existing) return { id: existing.id, deduped: true };
  return { id: record({ type, amount, userId, panditId, bookingId, kundaliId, refTable, refId, note }).id, deduped: false };
}

/* Reversal note: the ledger is append-only. A refund writes its own negative
   REFUND row referencing the booking; SERVICE_PAYMENT rows are never mutated. */

function list({ type, panditId, from, to, limit } = {}) {
  const w = [], a = [];
  if (type && TYPES.includes(type)) { w.push('type=?'); a.push(type); }
  if (panditId) { w.push('pandit_id=?'); a.push(panditId); }
  if (from) { w.push('created_at >= ?'); a.push(Number(from)); }
  if (to) { w.push('created_at <= ?'); a.push(Number(to)); }
  const rows = db.prepare(`SELECT t.*, u.name user_name, p.name pandit_name FROM transactions t
    LEFT JOIN users u ON u.id=t.user_id LEFT JOIN pandits p ON p.id=t.pandit_id
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY t.created_at DESC, t.id DESC LIMIT ?`)
    .all(...a, Math.min(500, Math.max(1, Number(limit) || 200)));
  return rows.map(out);
}

const out = (r) => ({
  id: r.id, type: r.type, amount: r.amount, userId: r.user_id, userName: r.user_name || null,
  panditId: r.pandit_id, panditName: r.pandit_name || null, bookingId: r.booking_id,
  kundaliId: r.kundali_id, refTable: r.ref_table, refId: r.ref_id, note: r.note || '',
  createdAt: r.created_at
});

/* Totals by type for the admin finance surface. */
function totals({ from, to } = {}) {
  const w = [], a = [];
  if (from) { w.push('created_at >= ?'); a.push(Number(from)); }
  if (to) { w.push('created_at <= ?'); a.push(Number(to)); }
  const rows = db.prepare(`SELECT type, SUM(amount) total, COUNT(*) n FROM transactions
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''} GROUP BY type`).all(...a);
  const byType = {};
  for (const r of rows) byType[r.type] = { total: r.total, count: r.n };
  byType._inflow = rows.filter((r) => r.total > 0).reduce((s, r) => s + r.total, 0);
  byType._outflow = rows.filter((r) => r.total < 0).reduce((s, r) => s + r.total, 0);
  return byType;
}

/* ---------------- Phase 9: effective-dated commission tiers ---------------- */

const tierOut = (r) => r && ({
  id: r.id, tier: r.tier, serviceCategory: r.service_category, commissionPct: r.commission_pct,
  panditSharePct: r.pandit_share_pct, effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
  active: !!r.active
});

function tierList() {
  return db.prepare('SELECT * FROM commission_tiers ORDER BY service_category, effective_from DESC, id DESC').all().map(tierOut);
}

/* Resolver: active tier whose category matches (exact first, then ALL) and
   whose effective window covers `on` (ISO date). Newest effective_from wins.
   Returns the tier row or null (caller falls back to the commission setting). */
function resolveTier(panditId, serviceCategory, on) {
  const date = on || new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT * FROM commission_tiers WHERE active=1
    AND (effective_from IS NULL OR effective_from <= ?)
    AND (effective_to IS NULL OR effective_to >= ?)
    AND service_category IN (?, 'ALL')
    ORDER BY CASE WHEN service_category = ? THEN 0 ELSE 1 END, effective_from DESC, id DESC`)
    .all(date, date, serviceCategory || 'ALL', serviceCategory || 'ALL');
  return rows.length ? tierOut(rows[0]) : null;
}

/* Payout-engine hook: the pct for a booking's pandit + puja category.
   Tier wins; settings fallback keeps legacy behaviour when no tier matches. */
function commissionPct({ panditId, serviceCategory }) {
  const tier = resolveTier(panditId, serviceCategory, null);
  if (tier) return { pct: tier.commissionPct, tier: tier.tier, tierId: tier.id };
  return { pct: getSetting('commission', 20), tier: null, tierId: null };
}

function tierCreate(actorUserId, body) {
  const b = body || {};
  const tier = String(b.tier || '').trim();
  if (!tier) throw bad('Tier name is required');
  const pct = Number(b.commissionPct);
  if (!Number.isFinite(pct) || pct < 0 || pct > 90) throw bad('Commission % must be 0..90');
  const share = Number(b.panditSharePct || 0);
  if (!Number.isFinite(share) || share < 0 || share > 100) throw bad('Pandit share % must be 0..100');
  if (pct + share > 100) throw bad('Commission + pandit share cannot exceed 100%');
  const id = db.prepare(`INSERT INTO commission_tiers(tier,service_category,commission_pct,pandit_share_pct,
    effective_from,effective_to,active) VALUES(?,?,?,?,?,?,?)`)
    .run(tier.slice(0, 40), b.serviceCategory || 'ALL', Math.round(pct), Math.round(share),
      b.effectiveFrom || null, b.effectiveTo || null, b.active === false ? 0 : 1).lastInsertRowid;
  audit(actorUserId, 'commission.tier_created', 'commission_tier', String(id),
    { tier, serviceCategory: b.serviceCategory || 'ALL', commissionPct: Math.round(pct), effectiveFrom: b.effectiveFrom || null },
    { newValue: { tier, commissionPct: Math.round(pct), effectiveFrom: b.effectiveFrom || null } });
  return tierOut(db.prepare('SELECT * FROM commission_tiers WHERE id=?').get(id));
}

function tierUpdate(actorUserId, id, body) {
  const row = db.prepare('SELECT * FROM commission_tiers WHERE id=?').get(id);
  if (!row) throw bad('Tier not found');
  const b = body || {};
  const next = {
    tier: b.tier !== undefined ? String(b.tier).slice(0, 40) : row.tier,
    service_category: b.serviceCategory !== undefined ? b.serviceCategory : row.service_category,
    commission_pct: b.commissionPct !== undefined ? Math.round(Number(b.commissionPct)) : row.commission_pct,
    pandit_share_pct: b.panditSharePct !== undefined ? Math.round(Number(b.panditSharePct)) : row.pandit_share_pct,
    effective_from: b.effectiveFrom !== undefined ? b.effectiveFrom : row.effective_from,
    effective_to: b.effectiveTo !== undefined ? b.effectiveTo : row.effective_to,
    active: b.active !== undefined ? (b.active ? 1 : 0) : row.active
  };
  if (!Number.isFinite(next.commission_pct) || next.commission_pct < 0 || next.commission_pct > 90) throw bad('Commission % must be 0..90');
  if (next.commission_pct + next.pandit_share_pct > 100) throw bad('Commission + pandit share cannot exceed 100%');
  db.prepare(`UPDATE commission_tiers SET tier=?, service_category=?, commission_pct=?, pandit_share_pct=?,
    effective_from=?, effective_to=?, active=? WHERE id=?`)
    .run(next.tier, next.service_category, next.commission_pct, next.pandit_share_pct,
      next.effective_from, next.effective_to, next.active, id);
  audit(actorUserId, 'commission.tier_updated', 'commission_tier', String(id),
    { from: { pct: row.commission_pct, active: !!row.active }, to: { pct: next.commission_pct, active: !!next.active } },
    { oldValue: { pct: row.commission_pct, active: !!row.active }, newValue: { pct: next.commission_pct, active: !!next.active } });
  return tierOut(db.prepare('SELECT * FROM commission_tiers WHERE id=?').get(id));
}

module.exports = { TYPES, record, dedupe, list, totals, out,
                   tierList, tierOut, resolveTier, commissionPct, tierCreate, tierUpdate };
