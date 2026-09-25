-- 010_photo_metadata.sql
-- Photo/media metadata per PHOTO-MEDIA-SPEC.md: provenance, licensing, alt text,
-- gallery category and thumbnails. schema_migrations guards re-runs (same
-- convention as 008/009); backfills are UPDATEs, which are naturally idempotent.

-- 1. New columns --------------------------------------------------------------
ALTER TABLE puja_media ADD COLUMN source TEXT NOT NULL DEFAULT 'admin'
  CHECK (source IN ('seeded','admin','pandit'));
ALTER TABLE puja_media ADD COLUMN license TEXT DEFAULT '';
ALTER TABLE puja_media ADD COLUMN credit TEXT DEFAULT '';
ALTER TABLE puja_media ADD COLUMN creator TEXT DEFAULT '';
ALTER TABLE puja_media ADD COLUMN credit_url TEXT DEFAULT '';
ALTER TABLE puja_media ADD COLUMN alt_text TEXT DEFAULT '';
ALTER TABLE puja_media ADD COLUMN category TEXT NOT NULL DEFAULT 'puja'
  CHECK (category IN ('puja','ritual','temple','seva'));
ALTER TABLE puja_media ADD COLUMN thumb TEXT DEFAULT '';

-- 2. Backfill ------------------------------------------------------------------
-- Pandit provenance: any row with a pandit_id was uploaded by a pandit.
UPDATE puja_media SET source='pandit' WHERE pandit_id IS NOT NULL;
-- Pandit uploads document a seva performed for a booking.
UPDATE puja_media SET category='seva' WHERE source='pandit' AND category='puja';
-- Seeded rows (admin1 uploads created by the photo seeder) carry the license data
-- applied by the seeder itself; rows named seed-<pujaId>-... get source='seeded'.
UPDATE puja_media SET source='seeded', category='ritual' WHERE filename LIKE 'seed-%';

-- 3. Indexes for the list/gallery queries --------------------------------------
CREATE INDEX IF NOT EXISTS idx_puja_media_status ON puja_media(status, created_at);
CREATE INDEX IF NOT EXISTS idx_puja_media_source ON puja_media(source);
CREATE INDEX IF NOT EXISTS idx_puja_media_cat ON puja_media(puja_id, category, is_published, status);
