-- 002_kundali_extensions.sql
-- Kundali (birth chart) and Havan Kund (fire pit) catalog: created new, since no
-- kundali module exists in the current schema despite what earlier specs assumed.
-- puja_kunds uses `recommended` (0/1), NOT `priority` — callers must not assume priority.

CREATE TABLE IF NOT EXISTS kundali_profiles(
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  name TEXT NOT NULL,
  gender TEXT CHECK (gender IN ('male','female','other')),
  dob TEXT NOT NULL,
  tob TEXT NOT NULL,
  pob TEXT NOT NULL,
  lat REAL, lon REAL, tz TEXT DEFAULT 'Asia/Kolkata',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_kundali_profiles_user ON kundali_profiles(user_id);

CREATE TABLE IF NOT EXISTS kundali_recommendations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL REFERENCES kundali_profiles(id),
  condition_code TEXT NOT NULL,
  puja_id TEXT REFERENCES pujas(id),
  reason TEXT DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_kundali_reco_profile ON kundali_recommendations(profile_id);

CREATE TABLE IF NOT EXISTS havan_kunds(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  material TEXT NOT NULL CHECK (material IN ('copper','brass','stone','clay','steel')),
  size_in INTEGER NOT NULL CHECK (size_in > 0),
  price INTEGER NOT NULL CHECK (price >= 0),
  descr TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS puja_kunds(
  puja_id TEXT NOT NULL REFERENCES pujas(id),
  kund_id TEXT NOT NULL REFERENCES havan_kunds(id),
  recommended INTEGER NOT NULL DEFAULT 0 CHECK (recommended IN (0,1)),
  PRIMARY KEY (puja_id, kund_id)
);

CREATE TABLE IF NOT EXISTS samagri_items(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'pcs',
  category TEXT DEFAULT 'general',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS puja_samagri(
  puja_id TEXT NOT NULL REFERENCES pujas(id),
  item_id TEXT NOT NULL REFERENCES samagri_items(id),
  qty INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  PRIMARY KEY (puja_id, item_id)
);

CREATE TABLE IF NOT EXISTS kundali_conditions(
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  descr TEXT DEFAULT '',
  severity TEXT DEFAULT 'low' CHECK (severity IN ('low','medium','high')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS condition_puja_rules(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  condition_code TEXT NOT NULL REFERENCES kundali_conditions(code),
  puja_id TEXT NOT NULL REFERENCES pujas(id),
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0),
  UNIQUE(condition_code, puja_id)
);

-- profile_id is nullable: guests can run an analysis from raw birth details without
-- saving a kundali profile first.
CREATE TABLE IF NOT EXISTS kundali_analysis(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT REFERENCES kundali_profiles(id),
  summary TEXT NOT NULL DEFAULT '{}',
  matched TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_kundali_analysis_profile ON kundali_analysis(profile_id, created_at);

CREATE TABLE IF NOT EXISTS kundali_activity(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Reference data so the catalog endpoints return something on a fresh install.
-- INSERT OR IGNORE keeps this safe when re-run.
INSERT OR IGNORE INTO havan_kunds(id,name,material,size_in,price,descr) VALUES
 ('hk_copper_9','Copper Havan Kund, 9 inch','copper',9,1501,'Traditional copper kund for griha pravesh and Satyanarayan katha'),
 ('hk_brass_12','Brass Havan Kund, 12 inch','brass',12,2400,'Sturdy brass kund for larger havans'),
 ('hk_stone_15','Stone Havan Kund, 15 inch','stone',15,3800,'Temple-style stone kund for extended rituals');

INSERT OR IGNORE INTO samagri_items(id,name,unit,category) VALUES
 ('si_ghee','Pure Cow Ghee','ml','havan'),
 ('si_camphor','Camphor tablets','pcs','havan'),
 ('si_wood','Mango Wood Sticks','pcs','havan'),
 ('si_sambrani','Sambrani cups','pcs','havan'),
 ('si_til','Black Sesame (Til)','g','havan'),
 ('si_akshat','Akshat (Unbroken Rice)','g','havan');

INSERT OR IGNORE INTO kundali_conditions(code,name,descr,severity) VALUES
 ('mangal_dosha','Mangal Dosha','Mars placement traditionally addressed before marriage','high'),
 ('kaal_sarp','Kaal Sarp Dosha','Rahu-Ketu axis traditionally addressed with Rudra worship','high'),
 ('shani_dasha','Shani Dasha','Saturn period traditionally addressed with Shani remedies','medium'),
 ('pitru_dosha','Pitru Dosha','Ancestral rites traditionally addressed with tarpan and Narayan bali','medium');

INSERT OR IGNORE INTO puja_kunds(puja_id,kund_id,recommended)
 SELECT 'rudra','hk_brass_12',1 WHERE EXISTS(SELECT 1 FROM pujas WHERE id='rudra');
INSERT OR IGNORE INTO puja_kunds(puja_id,kund_id,recommended)
 SELECT 'satyanarayan','hk_copper_9',1 WHERE EXISTS(SELECT 1 FROM pujas WHERE id='satyanarayan');

INSERT OR IGNORE INTO puja_samagri(puja_id,item_id,qty)
 SELECT 'rudra','si_ghee',500 WHERE EXISTS(SELECT 1 FROM pujas WHERE id='rudra');
INSERT OR IGNORE INTO puja_samagri(puja_id,item_id,qty)
 SELECT 'rudra','si_wood',21 WHERE EXISTS(SELECT 1 FROM pujas WHERE id='rudra');
INSERT OR IGNORE INTO puja_samagri(puja_id,item_id,qty)
 SELECT 'satyanarayan','si_akshat',100 WHERE EXISTS(SELECT 1 FROM pujas WHERE id='satyanarayan');

-- Condition -> puja rules link to existing seeded pujas only.
INSERT OR IGNORE INTO condition_puja_rules(condition_code,puja_id,weight)
 SELECT 'mangal_dosha','mangal',3 WHERE EXISTS(SELECT 1 FROM pujas WHERE id='mangal');
INSERT OR IGNORE INTO condition_puja_rules(condition_code,puja_id,weight)
 SELECT 'mangal_dosha','vivah',2 WHERE EXISTS(SELECT 1 FROM pujas WHERE id='vivah');
INSERT OR IGNORE INTO condition_puja_rules(condition_code,puja_id,weight)
 SELECT 'kaal_sarp','rudra',3 WHERE EXISTS(SELECT 1 FROM pujas WHERE id='rudra');
INSERT OR IGNORE INTO condition_puja_rules(condition_code,puja_id,weight)
 SELECT 'shani_dasha','shani',3 WHERE EXISTS(SELECT 1 FROM pujas WHERE id='shani');
INSERT OR IGNORE INTO condition_puja_rules(condition_code,puja_id,weight)
 SELECT 'pitru_dosha','pitru',3 WHERE EXISTS(SELECT 1 FROM pujas WHERE id='pitru');
