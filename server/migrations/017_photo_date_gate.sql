-- 017_photo_date_gate.sql
-- Phase 6: service photo date gate.
--
-- Spec: pandit uploads are allowed only on the scheduled puja date
-- (booking.date == today), with an admin override for exceptional cases
-- (reschedules, late evidence, demo workflows). Every override is audited.
--
--   bookings.media_override  admin-granted exception flag on the BOOKING (not
--                            per photo: the override must exist before the
--                            upload happens, so a per-media column can never be
--                            what the gate consults). Audited on flip via
--                            media.date_gate_override.
--   puja_media.upload_date   server-computed snapshot of booking.date stamped
--                            at upload time so the admin view can always show
--                            WHICH puja date a photo belongs to, even after
--                            the booking is rescheduled or completed.
--
-- Idempotency: same file-level transaction guarantee as 012–016 — the whole
-- file applies atomically or not at all, and schema_migrations prevents
-- re-application (same convention as 015/016's plain ALTER TABLE block).
-- Fresh installs get the identical columns from server/db.js bootstrap.

ALTER TABLE bookings ADD COLUMN media_override INTEGER NOT NULL DEFAULT 0;
ALTER TABLE puja_media ADD COLUMN upload_date TEXT NOT NULL DEFAULT '';
