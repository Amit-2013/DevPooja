-- 012_audit_payout_foundation.sql
-- Foundation layer for the master implementation plan (Phases 7, 8 and 31):
--   1. audit_logs enrichment — old/new value, reason, IP and device, so every
--      sensitive action can be reconstructed (Phase 31).
--   2. payouts enrichment — canonical statuses (PENDING/ON_HOLD/PROCESSING/
--      DISBURSED/FAILED/REVERSED), hold reasons, processing/disbursement dates,
--      payment reference + UTR, and a per-payout breakdown (gross, commission,
--      tax, refund, adjustments, net) so the centralized payout engine can be
--      built on the SAME table instead of a parallel one (Phases 7-8).
--
-- Idempotency: the runner (migrate.js / seed.js runMigrations) wraps this file in
-- a transaction and tracks it in schema_migrations, so file-level replay is safe
-- (same pattern as 008). SQLite has no ADD COLUMN IF NOT EXISTS, so replays of a
-- partially-applied file must be fixed by hand — that is why the runner is
-- transactional. Legacy statuses ('Pending', 'Paid' from earlier code/seed data)
-- are backfilled to the canonical vocabulary; the engine keeps accepting and
-- translating them.

-- 1. audit_logs enrichment (Phase 31) -----------------------------------------
ALTER TABLE audit_logs ADD COLUMN old_value TEXT;
ALTER TABLE audit_logs ADD COLUMN new_value TEXT;
ALTER TABLE audit_logs ADD COLUMN reason TEXT;
ALTER TABLE audit_logs ADD COLUMN ip TEXT;
ALTER TABLE audit_logs ADD COLUMN device TEXT;

-- 2. payouts enrichment (Phases 7-8) -------------------------------------------
ALTER TABLE payouts ADD COLUMN gross_amount INTEGER;
ALTER TABLE payouts ADD COLUMN commission_amt INTEGER;
ALTER TABLE payouts ADD COLUMN tax_amt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payouts ADD COLUMN refund_amt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payouts ADD COLUMN adjustment_amt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payouts ADD COLUMN currency TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE payouts ADD COLUMN hold_reason TEXT;
ALTER TABLE payouts ADD COLUMN hold_note TEXT;
ALTER TABLE payouts ADD COLUMN processing_date TEXT;
ALTER TABLE payouts ADD COLUMN disbursement_date TEXT;
ALTER TABLE payouts ADD COLUMN payment_ref TEXT;
ALTER TABLE payouts ADD COLUMN utr TEXT;

-- Canonical statuses + per-payout money trail for existing rows. Amount stays
-- the authoritative net; the breakdown columns are backfilled from it.
UPDATE payouts SET status = 'PENDING', gross_amount = amount,
       commission_amt = 0, adjustment_amt = 0
 WHERE status IN ('Pending', 'pending', '');
UPDATE payouts SET status = 'DISBURSED', gross_amount = amount,
       commission_amt = 0, adjustment_amt = 0, disbursement_date = date
 WHERE status IN ('Paid', 'paid');

CREATE INDEX IF NOT EXISTS idx_payout_status ON payouts(status);
CREATE INDEX IF NOT EXISTS idx_payout_pandit ON payouts(pandit_id);

-- 3. Default payout holds (engine fallback; overridable via Admin settings) ----
INSERT INTO settings(key, value)
  SELECT 'payout_holds', '[{"reason":"KYC Pending","check":"pandit_kyc"},{"reason":"Bank Verification Pending","check":"bank"},{"reason":"Customer Dispute","check":"dispute"},{"reason":"Booking Under Review","check":"review"},{"reason":"Refund Pending","check":"refund"},{"reason":"Payment Reconciliation","check":"reconciliation"},{"reason":"Admin Hold","check":"admin"}]'
  WHERE NOT EXISTS(SELECT 1 FROM settings WHERE key = 'payout_holds');
