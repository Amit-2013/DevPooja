-- 030_people_cms.sql
-- Additional-requirements Phase B: the Our People CMS.
--
-- Decision: people and their categories are DATABASE ROWS, never hard-coded
-- pages. The nine categories are reference data seeded here with guarded
-- INSERTs (a demo RESET replays migration seeds, so every statement is a
-- NOT EXISTS-guarded no-op on an intact database). Every person — including
-- the Founder and the Main Acharya — is an ordinary row in the same table,
-- managed from the admin portal with the usual audit trail; the richer public
-- layout for the first two categories is a presentation choice on the
-- frontend, not a separate content type.
--
--   people_categories  the ordered public grouping (Founder -> Team); rows are
--                      deactivated, never silently dropped while people use them
--   people             one admin-managed profile: name/designation/category/
--                      city/country/experience/qualifications/expertise/story/
--                      background/sanatan work, an optional profile photo with
--                      its generated variants, an optional video and social links
--   people_photos      optional gallery photos for a profile, with the same
--                      original + thumb + WebP variant set as puja media
--
-- Idempotency: CREATE TABLE/INDEX IF NOT EXISTS + guarded seed INSERTs per the
-- 015-029 convention; schema_migrations prevents re-application.

CREATE TABLE IF NOT EXISTS people_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created INTEGER
);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  designation TEXT NOT NULL DEFAULT '',
  category_id TEXT,
  city TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  experience INTEGER NOT NULL DEFAULT 0,
  qualifications TEXT NOT NULL DEFAULT '',
  expertise TEXT NOT NULL DEFAULT '[]',       -- JSON array of strings
  intro TEXT NOT NULL DEFAULT '',             -- one-line summary for listings
  bio TEXT NOT NULL DEFAULT '',               -- the full story
  background TEXT NOT NULL DEFAULT '',
  sanatan_work TEXT NOT NULL DEFAULT '',
  photo_file TEXT,                            -- basename under uploads/media
  photo_thumb TEXT,
  photo_webp TEXT,
  photo_thumb_webp TEXT,
  video_url TEXT NOT NULL DEFAULT '',         -- optional YouTube/Vimeo link
  socials TEXT NOT NULL DEFAULT '[]',         -- JSON [{platform,url}]
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created INTEGER,
  updated INTEGER
);

CREATE TABLE IF NOT EXISTS people_photos (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  thumb TEXT,
  webp TEXT,
  thumb_webp TEXT,
  caption TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created INTEGER
);

CREATE INDEX IF NOT EXISTS idx_people_category ON people(category_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_people_active ON people(active, sort_order);
CREATE INDEX IF NOT EXISTS idx_people_photos_person ON people_photos(person_id, sort_order);

-- The nine categories in their public order. Guarded so replaying the seed
-- after a demo RESET never duplicates or resurrects a renamed category.
INSERT INTO people_categories(id,name,sort_order,active,created)
  SELECT 'founder','Founder',1,1,CAST(strftime('%s','now') AS INTEGER)*1000
  WHERE NOT EXISTS(SELECT 1 FROM people_categories WHERE id='founder');
INSERT INTO people_categories(id,name,sort_order,active,created)
  SELECT 'main-acharya','Main Acharya',2,1,CAST(strftime('%s','now') AS INTEGER)*1000
  WHERE NOT EXISTS(SELECT 1 FROM people_categories WHERE id='main-acharya');
INSERT INTO people_categories(id,name,sort_order,active,created)
  SELECT 'acharyas','Acharyas',3,1,CAST(strftime('%s','now') AS INTEGER)*1000
  WHERE NOT EXISTS(SELECT 1 FROM people_categories WHERE id='acharyas');
INSERT INTO people_categories(id,name,sort_order,active,created)
  SELECT 'vedic-scholars','Vedic Scholars',4,1,CAST(strftime('%s','now') AS INTEGER)*1000
  WHERE NOT EXISTS(SELECT 1 FROM people_categories WHERE id='vedic-scholars');
INSERT INTO people_categories(id,name,sort_order,active,created)
  SELECT 'jyotish-experts','Jyotish Experts',5,1,CAST(strftime('%s','now') AS INTEGER)*1000
  WHERE NOT EXISTS(SELECT 1 FROM people_categories WHERE id='jyotish-experts');
INSERT INTO people_categories(id,name,sort_order,active,created)
  SELECT 'pandits','Pandits',6,1,CAST(strftime('%s','now') AS INTEGER)*1000
  WHERE NOT EXISTS(SELECT 1 FROM people_categories WHERE id='pandits');
INSERT INTO people_categories(id,name,sort_order,active,created)
  SELECT 'temple-reps','Temple Representatives',7,1,CAST(strftime('%s','now') AS INTEGER)*1000
  WHERE NOT EXISTS(SELECT 1 FROM people_categories WHERE id='temple-reps');
INSERT INTO people_categories(id,name,sort_order,active,created)
  SELECT 'advisors','Advisors',8,1,CAST(strftime('%s','now') AS INTEGER)*1000
  WHERE NOT EXISTS(SELECT 1 FROM people_categories WHERE id='advisors');
INSERT INTO people_categories(id,name,sort_order,active,created)
  SELECT 'team','Team',9,1,CAST(strftime('%s','now') AS INTEGER)*1000
  WHERE NOT EXISTS(SELECT 1 FROM people_categories WHERE id='team');
