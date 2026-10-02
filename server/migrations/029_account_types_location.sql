-- 029_account_types_location.sql
-- Additional-requirements Phase A: NRI accounts and profile location.
--
-- Decision: an NRI user is the SAME customer account with account_type='nri' —
-- never a second account, a second users row, or a separate auth path. The
-- existing email/mobile uniqueness therefore keeps preventing duplicates, and
-- bookings, kundalis, orders, payments and family members can never detach
-- because nothing about their foreign keys changes.
--
--   account_type  'normal' (default, existing rows unchanged) | 'nri'
--   location      JSON text, only what the app needs:
--                 {city, country, lat, lon, source:'auto'|'manual',
--                  consentAt, updatedAt} — written through PATCH /me,
--                 empty object = not shared (never forced)
--
-- Idempotency: plain ALTER TABLE block per the 015-028 convention;
-- schema_migrations prevents re-application.

ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE users ADD COLUMN location TEXT NOT NULL DEFAULT '{}';
