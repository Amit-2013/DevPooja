-- 013_pandit_availability.sql
-- Phase 3: ONE centralized availability calendar, added to the SAME pandits table
-- (no parallel availability table). The booking engine checks, in order:
--   status/avail -> weekly off -> holiday -> blocked date -> marked-off date ->
--   time slot -> online/temple capability -> home radius -> slot conflict
-- and turns every failure into a human-readable reason (BOOKABLE / NOT BOOKABLE
-- with WHY).
--
-- Compatibility (master plan Phase 2/36: never break existing data):
--   - weekly_off / slots / holidays / blocked_dates default EMPTY = no restriction,
--     so every seeded and existing pandit stays bookable exactly as before;
--   - slots empty means "all slots" (the shared SLOTS list);
--   - radius_km / base_lat / base_lon are NULL = home-puja radius NOT enforced.
-- Idempotency: same file-level transaction guarantee as 008/012.

ALTER TABLE pandits ADD COLUMN weekly_off TEXT NOT NULL DEFAULT '[]';
ALTER TABLE pandits ADD COLUMN slots TEXT NOT NULL DEFAULT '[]';
ALTER TABLE pandits ADD COLUMN holidays TEXT NOT NULL DEFAULT '[]';
ALTER TABLE pandits ADD COLUMN blocked_dates TEXT NOT NULL DEFAULT '[]';
ALTER TABLE pandits ADD COLUMN radius_km INTEGER;
ALTER TABLE pandits ADD COLUMN base_lat REAL;
ALTER TABLE pandits ADD COLUMN base_lon REAL;
ALTER TABLE pandits ADD COLUMN online_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE pandits ADD COLUMN temple_enabled INTEGER NOT NULL DEFAULT 1;

-- Demo convenience only: give the flagship pandit a base coordinate so radius
-- rules are demonstrable. Guarded, so replays/no-op on non-demo data are safe.
UPDATE pandits SET base_lat = 28.6139, base_lon = 77.2090
 WHERE id = 'p1' AND base_lat IS NULL
   AND EXISTS (SELECT 1 FROM place_index WHERE city = 'Delhi' AND country = 'India');
