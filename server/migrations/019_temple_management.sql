-- 019_temple_management.sql
-- Phase 12: temple management — admin CRUD over the SAME temples row
-- (extension-first; nothing moves tables).
--
--   active    0 = delisted: hidden from the customer temple directory and the
--             state payload, and temple-mode bookings for it are refused. NOT
--             deletion — bookings may reference the temple; DELETE answers 409
--             when past bookings exist and points at this flag instead.
--   timings   free-text darshan/aarti timings, e.g. "6:00 AM - 12:00 PM, 4:00 -
--             8:00 PM" — shown on the public temple directory cards and edited
--             in the admin modal.
--   photo     URL/relative path to the temple image, served like other media;
--             empty = icon-only card as today.
--
-- Idempotency: same file-level transaction guarantee as 012–018 — the whole
-- file applies atomically or not at all, and schema_migrations prevents
-- re-application (plain ALTER TABLE block per 015–018 convention).

ALTER TABLE temples ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE temples ADD COLUMN timings TEXT;
ALTER TABLE temples ADD COLUMN photo TEXT;
