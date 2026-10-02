-- 031_social_links.sql
-- Additional-requirements Phase C: the Social Media CMS.
--
-- Decision: the platform's social presence is admin-managed ROWS, never
-- hard-coded links or hard-coded SVG markup in the footer. Each row stores the
-- platform handle, which built-in icon to draw (a key into the frontend's
-- inline SVG set — unknown keys fall back to the generic globe icon, so a new
-- platform never breaks the footer), the URL, plus visibility and order.
--
--   platform  the handle shown to admins (facebook, instagram, youtube, ...)
--   icon      icon key from the built-in set; empty = draw the platform key,
--             unknown key = the generic fallback (never a broken image)
--   url       the profile URL (http/https only, validated on write)
--   active    disabled links stay in the admin list but leave the footer
--
-- The demo rows (Facebook, Instagram, YouTube + one disabled international
-- example) are seeded by the DEMO_MODE seeders, never here: production starts
-- with an empty social row and the footer simply renders nothing.
--
-- Idempotency: CREATE TABLE/INDEX IF NOT EXISTS per the 015-030 convention;
-- schema_migrations prevents re-application.

CREATE TABLE IF NOT EXISTS social_links (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created INTEGER
);

CREATE INDEX IF NOT EXISTS idx_social_links_active ON social_links(active, sort_order);
