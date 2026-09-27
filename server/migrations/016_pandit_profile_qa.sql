-- 016_pandit_profile_qa.sql
-- Phases 5 + 17: pandit profile enrichment + the QA & rating engine.
--
-- Phase 5 extends the SAME pandits row (extension-first; nothing moves tables):
--   photo_file    profile photo (stored under uploads/media, served from /media)
--   gotra         lineage (free text, e.g. "Bharadwaj")
--   qualifications newline/comma-separated free text (degrees, sampradaya training)
--   veda_school   tradition/sampradaya (free text, e.g. "Smarta", "Sri Vidya")
--   qa_score      cached average of qa_records.overall, refreshed on every QA
--                 write (services/qa.js); canonical recomputation lives there
--   cancel_pct    DERIVED on read (bookings attribution), never stored — see
--                 services/qa.js. No-show proxy: same derivation.
--
-- Phase 17 adds qa_records: one scored observation per booking by an admin.
-- Dimension vocabulary mirrors 014's trial_poojas so trial onboarding and live
-- QA speak the same language:
--   punctuality, communication, ritual_compliance, presentation,
--   customer_interaction, digital_capability, documentation
-- qa_score on pandits is a cached average refreshed on every write (cheap,
-- readable; the canonical recomputation stays in services/qa.js).
--
-- Idempotency: same file-level transaction guarantee as 012/013/014/015 — the
-- whole file applies atomically or not at all, and schema_migrations prevents
-- re-application (same convention as 015's plain ALTER TABLE block).

ALTER TABLE pandits ADD COLUMN photo_file TEXT;
ALTER TABLE pandits ADD COLUMN gotra TEXT;
ALTER TABLE pandits ADD COLUMN qualifications TEXT;
ALTER TABLE pandits ADD COLUMN veda_school TEXT;
ALTER TABLE pandits ADD COLUMN qa_score REAL;

CREATE TABLE IF NOT EXISTS qa_records(
  id TEXT PRIMARY KEY,
  pandit_id TEXT NOT NULL REFERENCES pandits(id),
  booking_id TEXT REFERENCES bookings(id),
  evaluator TEXT NOT NULL,
  punctuality INTEGER,
  communication INTEGER,
  ritual_compliance INTEGER,
  presentation INTEGER,
  customer_interaction INTEGER,
  digital_capability INTEGER,
  documentation INTEGER,
  overall INTEGER,
  notes TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_pandit ON qa_records(pandit_id);
CREATE INDEX IF NOT EXISTS idx_qa_booking ON qa_records(booking_id);
