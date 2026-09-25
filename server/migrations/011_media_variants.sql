-- 011_media_variants.sql
-- WebP variants + moderation feedback. Purely ADDITIVE: the approval state machine
-- (status / is_published / is_primary) from migrations 009/010 is unchanged.
--
-- Columns:
--   webp        server-generated WebP of the ORIGINAL (large view), stored path
--   thumb_webp  server-generated 320px WebP of the thumbnail, stored path
--   reject_reason  admin note written when a photo is rejected (pandit-visible)
-- NULL means "variant not generated yet"; the variant repair service fills these
-- idempotently on boot (only for rows where the column is NULL/empty).

ALTER TABLE puja_media ADD COLUMN webp TEXT DEFAULT '';
ALTER TABLE puja_media ADD COLUMN thumb_webp TEXT DEFAULT '';
ALTER TABLE puja_media ADD COLUMN reject_reason TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_puja_media_webp ON puja_media(is_published, status);
