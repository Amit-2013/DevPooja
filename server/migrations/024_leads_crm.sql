-- 024_leads_crm.sql
-- Phase 26: leads become a working CRM object, not a four-column enquiry dump.
--
-- The legacy shape (id, type, name, details, date) came from the public
-- enquiry forms only. Every existing row keeps its meaning:
--   type      → source label (Contact/Corporate/Astrology/Kundli were the only
--               capture surfaces, so `type` IS the capture source)
--   name      → name (verified by the capture validator, never empty)
--   details   → notes (the free-text blob; structured fields stay empty)
--   date      → created (YYYY-MM-DD string → epoch-ms, midnight local)
--
-- New columns (all nullable / defaulted — pure additive ALTER block per the
-- 015–023 convention):
--   mobile / email   contact channels (the enquiry forms never captured them;
--                    captured programmatically from now on)
--   service          the puja the lead is interested in (pujas.id reference,
--                    free text so legacy services stay valid)
--   location         city / area
--   assigned_to      the admin user working the lead
--   status           NEW | CONTACTED | QUALIFIED | CONVERTED | LOST (default NEW)
--   follow_up_at     epoch ms of the next follow-up
--   converted_booking_id   set on conversion (leads report joins it)
--
-- Idempotency: plain ALTER TABLE block; schema_migrations prevents
-- re-application. Whole file applies atomically or not at all.

ALTER TABLE leads ADD COLUMN mobile TEXT DEFAULT '';
ALTER TABLE leads ADD COLUMN email TEXT DEFAULT '';
ALTER TABLE leads ADD COLUMN service TEXT DEFAULT '';
ALTER TABLE leads ADD COLUMN location TEXT DEFAULT '';
ALTER TABLE leads ADD COLUMN assigned_to TEXT;
ALTER TABLE leads ADD COLUMN status TEXT NOT NULL DEFAULT 'NEW';
ALTER TABLE leads ADD COLUMN follow_up_at INTEGER;
ALTER TABLE leads ADD COLUMN converted_booking_id TEXT;

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
