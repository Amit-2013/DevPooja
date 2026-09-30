-- 025_booking_review_hold.sql
-- Per-pandit flagging follow-up: while a pandit is flagged by the reopen
-- digest (live incidents reopened across DISTINCT bookings beyond
-- REOPEN_LIMIT), their NEW bookings are stamped with a review hold.
--
--   review_hold   1 = the booking waits for an admin release; the assigned
--                 pandit cannot accept or start it while the flag stands
--   hold_reason   the human-readable why (same wording everywhere)
--
-- The hold is per-BOOKING (a booking created while the pandit was flagged
-- keeps the hold until released or auto-released), never a pandit-level
-- block: resolved incidents clear the flag and held bookings free up
-- automatically (boot sweep + digest view + guard fallback). Admins always
-- retain the explicit POST /admin/bookings/:id/release-hold override.
--
-- Idempotency: plain ALTER TABLE block per the 015–024 convention;
-- schema_migrations prevents re-application. Atomic per file.

ALTER TABLE bookings ADD COLUMN review_hold INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN hold_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_bookings_hold ON bookings(review_hold) WHERE review_hold=1;
