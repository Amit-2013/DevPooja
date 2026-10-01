-- 027_lead_dedupe.sql
-- Lead capture dedupe: the pipeline stores one row per prospect, not one row
-- per submission. Repeated enquiries from the same person merge into the
-- EXISTING lead (earliest row wins) instead of piling up near-copies.
--
-- New columns on leads (additive ALTER block per the 015–026 convention):
--   dup_count    how many later submissions merged into this row
--   last_dup_at  epoch ms of the most recent merge (admin visibility)
--
-- Merge semantics live in services/leads.js + app/services/leads.py: an
-- incoming capture whose mobile or email matches an existing lead backfills
-- that lead's empty fields, appends a dated note line and bumps the counter —
-- no new row. CONVERTED rows are terminal (never merge targets); LOST rows
-- re-open as NEW when a person enquires again (a lost lead asking again IS a
-- new opportunity, and the pipeline is the place to work it).
--
-- Idempotency: plain ALTER TABLE + CREATE INDEX IF NOT EXISTS block per the
-- 015-026 convention; schema_migrations prevents re-application.

ALTER TABLE leads ADD COLUMN dup_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN last_dup_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_leads_mobile ON leads(mobile) WHERE mobile != '';
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email) WHERE email != '';
