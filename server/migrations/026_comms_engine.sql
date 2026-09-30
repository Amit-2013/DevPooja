-- 026_comms_engine.sql
-- Phases 27-29: campaigns become a real lifecycle and every notification gets
-- a delivery record.
--
--   campaigns extensions:
--     message        the notification body (validated non-empty on send)
--     scheduled_at   epoch ms when the campaign is meant to go out
--     created_by     admin user id (audit companion)
--     created_at     epoch ms
--     sent_at        epoch ms of the actual send
--     failed         count of failed deliveries on the send
--   Legacy rows (status 'Scheduled', no message) backfill to DRAFT with an
--   empty message — they must be scheduled/sent through the new engine.
--
--   notification_deliveries: one row per recipient per send — SENT (notifs
--   row + provider fired), SKIPPED (no consent or no contact target), FAILED
--   (provider error). This is what the campaign detail view aggregates.
--
-- Idempotency: plain ALTER TABLE + CREATE TABLE IF NOT EXISTS block per the
-- 015-025 convention; schema_migrations prevents re-application.

ALTER TABLE campaigns ADD COLUMN message TEXT DEFAULT '';
ALTER TABLE campaigns ADD COLUMN scheduled_at INTEGER;
ALTER TABLE campaigns ADD COLUMN created_by TEXT;
ALTER TABLE campaigns ADD COLUMN created_at INTEGER;
ALTER TABLE campaigns ADD COLUMN sent_at INTEGER;
ALTER TABLE campaigns ADD COLUMN failed INTEGER NOT NULL DEFAULT 0;

-- Legacy fake-state rows: no message, never actually sent.
UPDATE campaigns SET status='DRAFT' WHERE status='Scheduled';

CREATE TABLE IF NOT EXISTS notification_deliveries(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SENT',   -- SENT | SKIPPED | FAILED
  detail TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nd_campaign ON notification_deliveries(campaign_id);
