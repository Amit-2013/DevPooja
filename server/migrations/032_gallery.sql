-- 032_gallery.sql
-- Additional-requirements Phase D: the Photo + Video Gallery.
--
-- Decision: gallery content is DATABASE ROWS, never hard-coded markup. Three
-- admin-managed tables, no seeded content here — demo rows come from the
-- DEMO_MODE seeders, production starts with an empty public gallery.
--
--   gallery_albums  ordered groupings shown as the public Albums tab. Deleting
--                   an album never deletes media: its photos and videos become
--                   un-albumed and stay in the Photos/Videos tabs (curated
--                   images are lost only through an explicit, audited photo or
--                   video delete)
--   gallery_photos   one uploaded image + its generated variants (320px JPEG
--                    thumb, full-size WebP, thumb WebP — same pipeline as
--                    people photos and puja media), caption/alt text and
--                    PHOTO-MEDIA-SPEC-style provenance (license, credit,
--                    credit_url) so attribution survives the copy
--   gallery_videos   a YouTube link (validated on write) with a title and
--                    description. Decision: videos are EXTERNAL embeds, not
--                    file uploads — hosting 40MB video files is a separate
--                    storage/CDN concern; the embed id is derived from the URL
--                    on read, so a URL edit is all that is ever needed.
--
--   active           per-row publish flag: hidden rows stay manageable in the
--                    admin portal but never reach the public gallery
--   album_id         nullable on photos AND videos — NULL means "un-albumed",
--                    which is exactly what a deleted album leaves behind
--
-- Idempotency: CREATE TABLE/INDEX IF NOT EXISTS per the 015-031 convention;
-- schema_migrations prevents re-application.

CREATE TABLE IF NOT EXISTS gallery_albums (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created INTEGER,
  updated INTEGER
);

CREATE TABLE IF NOT EXISTS gallery_photos (
  id TEXT PRIMARY KEY,
  album_id TEXT,
  filename TEXT NOT NULL,
  thumb TEXT,
  webp TEXT,
  thumb_webp TEXT,
  caption TEXT NOT NULL DEFAULT '',
  alt_text TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '',
  credit TEXT NOT NULL DEFAULT '',
  credit_url TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created INTEGER,
  updated INTEGER
);

CREATE TABLE IF NOT EXISTS gallery_videos (
  id TEXT PRIMARY KEY,
  album_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created INTEGER,
  updated INTEGER
);

CREATE INDEX IF NOT EXISTS idx_gallery_albums_active ON gallery_albums(active, sort_order);
CREATE INDEX IF NOT EXISTS idx_gallery_photos_album ON gallery_photos(album_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_gallery_photos_active ON gallery_photos(active, sort_order);
CREATE INDEX IF NOT EXISTS idx_gallery_videos_album ON gallery_videos(album_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_gallery_videos_active ON gallery_videos(active, sort_order);
