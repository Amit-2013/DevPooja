-- 028_customer_hold.sql
-- Customer-conduct escalation decision: a customer whose bookings accumulate
-- reopened incidents across DISTINCT bookings beyond REOPEN_LIMIT (the
-- flaggedCustomers demand-side signal) gets a SOFT review flag on their NEW
-- bookings — mirroring the pandit review hold (migration 025) — instead of a
-- coupon/discount hold (rejected: it punishes through a channel unrelated to
-- the conduct risk and has no pending-review flow).
--
--   customer_hold        1 = the booking waits for an admin review before
--                        the fulfilment flow treats it as trusted (accept/
--                        start proceeds for the pandit, but admins see the
--                        hold and the explicit release endpoint clears it)
--   customer_hold_reason the human-readable why (same wording everywhere)
--
-- The hold is per-BOOKING (a booking created while the customer was flagged
-- keeps the hold until released or auto-released), never a customer-level
-- block: resolved incidents clear the flag and held bookings free up
-- automatically (boot sweep + digest view + stamp-time fallback), and the
-- pandit experience is unchanged — the customer-conduct risk is a TRUST
-- signal for the ops team, not a fulfilment blocker.
--
-- Idempotency: plain ALTER TABLE + CREATE INDEX IF NOT EXISTS block per the
-- 015-027 convention; schema_migrations prevents re-application. Atomic per file.

ALTER TABLE bookings ADD COLUMN customer_hold INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN customer_hold_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_bookings_customer_hold ON bookings(customer_hold) WHERE customer_hold=1;
