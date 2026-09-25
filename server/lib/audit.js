/* Audit + login-activity helpers (single source of truth for the admin audit log).
   Reuses the audit_logs table from migration 001. Never logs passwords, tokens or
   OTPs — `detail` carries only non-sensitive identifiers. */
'use strict';
const { db } = require('../db');

/* One audited action: admin password resets, account status flips, media moderation,
   exports. actorRole is derived from the users row when not given. */
function audit(actorUserId, action, entity, entityId, detail, ip) {
  try {
    const u = actorUserId ? db.prepare('SELECT role FROM users WHERE id=?').get(actorUserId) : null;
    db.prepare('INSERT INTO audit_logs(actor_user_id,actor_role,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(actorUserId || null, u ? u.role : (actorUserId ? 'system' : null), action, entity, entityId || null,
        JSON.stringify(detail || {}), Date.now());
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
