-- 020_puja_mode_pricing.sql
-- Phase 11: per-mode puja pricing + mode availability.
--
--   price_home / price_online / price_temple / price_custom
--       FLAT service price for that mode (NULL = inherit the legacy formula:
--       round(price * modeFactor * panditPf / 10) * 10). Flat means what the
--       admin typed is what the customer pays — the pandit pf multiplier does
--       not apply to an explicit per-mode price.
--   modes
--       JSON array of the modes this puja can be booked in
--       (["home","online","temple","custom"] default). Modes outside the list
--       are refused by priceRequest — a puja can become online-only or drop
--       temple service per-puja.
--
-- Idempotency: same file-level transaction guarantee as 012–019 — the whole
-- file applies atomically or not at all, and schema_migrations prevents
-- re-application (plain ALTER TABLE block per 015–019 convention).

ALTER TABLE pujas ADD COLUMN price_home INTEGER;
ALTER TABLE pujas ADD COLUMN price_online INTEGER;
ALTER TABLE pujas ADD COLUMN price_temple INTEGER;
ALTER TABLE pujas ADD COLUMN price_custom INTEGER;
ALTER TABLE pujas ADD COLUMN modes TEXT NOT NULL DEFAULT '["home","online","temple","custom"]';
