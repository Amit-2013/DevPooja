/* Audit + login-activity helpers (single source of truth for the admin audit log).
   Reuses the audit_logs table from migration 001, enriched by migration 012 with
   old_value / new_value / reason / ip / device (master plan Phase 31). Never logs
   passwords, tokens or OTPs — `detail` carries only non-sensitive identifiers. */
'use strict';
const { db } = require('../db');

/* One audited action: admin password resets, account status flips, media moderation,
   exports, payout transitions, commission changes…
   - actorRole is derived from the users row when not given.
   - extra (optional): a string is shorthand for { reason }, an object may carry
     { reason, ip, device, oldValue, newValue } — oldValue/newValue are JSON-encoded
     into the dedicated columns so value histories are queryable, not buried in detail. */
function audit(actorUserId, action, entity, entityId, detail, extra) {
  try {
    const opts = typeof extra === 'string' ? { reason: extra } : (extra || {});
    const u = actorUserId ? db.prepare('SELECT role FROM users WHERE id=?').get(actorUserId) : null;
    db.prepare(`INSERT INTO audit_logs(actor_user_id,actor_role,action,entity,entity_id,detail,
      old_value,new_value,reason,ip,device,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(actorUserId || null, u ? u.role : (actorUserId ? 'system' : null), action, entity, entityId || null,
        JSON.stringify(detail || {}),
        opts.oldValue === undefined ? null : JSON.stringify(opts.oldValue),
        opts.newValue === undefined ? null : JSON.stringify(opts.newValue),
        opts.reason ? String(opts.reason).slice(0, 300) : null,
        opts.ip ? String(opts.ip).slice(0, 60) : null,
        opts.device ? String(opts.device).slice(0, 200) : null,
        Date.now());
  } catch (e) { console.error('[audit]', e.message); }
}

/* Every login attempt (success or failure) for the admin Login activity report. */
function logLogin(userId, method, ok, reason, ip) {
  try {
    db.prepare('INSERT INTO login_activity(user_id,method,ok,reason,ip,ts) VALUES(?,?,?,?,?,?)')
      .run(userId || null, method || 'unknown', ok ? 1 : 0, String(reason || '').slice(0, 120), String(ip || '').slice(0, 60), Date.now());
  } catch (e) { console.error('[login-activity]', e.message); }
}

/* Counted queries for the admin audit view. */
const recent = (limit = 200) => db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit);

module.exports = { audit, logLogin, recent };
