-- 033_notifications_read.sql
-- Admin notifications centre: read/unread state for the in-app store that
-- notify() and comms.deliver() write. The header bell badge counts rows where
-- read_at IS NULL; POST /me/notifs/read stamps them (all of the caller's rows,
-- or just the ids the panel displayed).
--
--   read_at  epoch-ms when the owner viewed it; NULL = unread
--
-- Backfill: rows that predate the bell are stamped with their own send time,
-- so the badge starts clean on an existing install instead of counting every
-- historic notification as unread.
--
-- Idempotency: plain ALTER TABLE block per the 015-032 convention;
-- schema_migrations prevents re-application. Atomic per file.

ALTER TABLE notifs ADD COLUMN read_at INTEGER;

UPDATE notifs SET read_at = ts WHERE read_at IS NULL;
