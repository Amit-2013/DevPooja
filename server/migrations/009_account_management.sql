-- 009_account_management.sql
-- Admin account management + Puja photo/media management.
-- Follows the 008 convention: bare ALTERs are safe because schema_migrations
-- guards re-runs, and the db.js base schema (which already has `users`) covers
-- both fresh and existing databases. The audit trail REUSES the audit_logs
-- table created by migration 001 — no duplicate audit system is introduced.

-- 1. users: account status and password lifecycle ------------------------------
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';      -- active | suspended | disabled
ALTER TABLE users ADD COLUMN force_change INTEGER NOT NULL DEFAULT 0;    -- admin forces a password change at next login
ALTER TABLE users ADD COLUMN last_login_at INTEGER;
ALTER TABLE users ADD COLUMN last_login_method TEXT DEFAULT '';          -- mobile-otp | email | admin
ALTER TABLE users ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until INTEGER;                       -- failed-login lockout (5 fails -> 15 min)

-- 2. Login activity (who logged in, how, from where; failures included) --------
CREATE TABLE IF NOT EXISTS login_activity(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  method TEXT NOT NULL,             -- mobile-otp | email | admin | demo
  ok INTEGER NOT NULL DEFAULT 1,
  reason TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  ts INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_login_activity_user ON login_activity(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_login_activity_ts ON login_activity(ts);

-- 3. Secure password resets (crypto-random, hashed, single-use, short-lived) ----
CREATE TABLE IF NOT EXISTS password_resets(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL,
  expires INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,                  -- admin user id when admin-initiated
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);

-- 4. Puja media (photos for pujas; optional booking/pandit provenance) ----------
-- Storage reuses uploads/media (same disk layout as booking completion media).
CREATE TABLE IF NOT EXISTS puja_media(
  id TEXT PRIMARY KEY,
  puja_id TEXT NOT NULL REFERENCES pujas(id),
  booking_id TEXT REFERENCES bookings(id),
  pandit_id TEXT REFERENCES pandits(id),
  uploaded_by TEXT,
  orig_name TEXT DEFAULT '',
  filename TEXT NOT NULL,           -- server-generated name inside uploads/media
  mime TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING_ADMIN_REVIEW'
    CHECK (status IN ('PENDING_ADMIN_REVIEW','APPROVED','REJECTED')),
  is_primary INTEGER NOT NULL DEFAULT 0,
  is_published INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_puja_media_puja ON puja_media(puja_id);
CREATE INDEX IF NOT EXISTS idx_puja_media_booking ON puja_media(booking_id);
CREATE INDEX IF NOT EXISTS idx_puja_media_pandit ON puja_media(pandit_id);
