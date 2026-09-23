-- 003_kundali_flow.sql
-- Kundali -> Dosh -> Recommendation flow: generated charts, per-condition dosh
-- analysis rows, puja recommendations, a searchable birth-place index, and richer
-- condition/rule metadata (priority tiers + editable reason text).
-- Everything is idempotent (IF NOT EXISTS / INSERT OR IGNORE / guarded ALTERs).

CREATE TABLE IF NOT EXISTS kundalis(
  id TEXT PRIMARY KEY,
  profile_id TEXT REFERENCES kundali_profiles(id),
  name TEXT NOT NULL,
  chart_data TEXT NOT NULL DEFAULT '{}',      -- full generated chart (positions, houses, panchang)
  planetary_data TEXT NOT NULL DEFAULT '{}',  -- analysis view: signs/houses/dignity per planet
  lagna TEXT DEFAULT '',                      -- sign name, denormalised for display
  rashi TEXT DEFAULT '',
  nakshatra TEXT DEFAULT '',
  pada INTEGER,
  dasha_data TEXT DEFAULT '{}',
  navamsa_data TEXT DEFAULT '{}',
  calculation_version TEXT NOT NULL DEFAULT 'internal-ephemeris-v1',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_kundalis_profile ON kundalis(profile_id, created_at);

CREATE TABLE IF NOT EXISTS dosh_analysis(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kundali_id TEXT NOT NULL REFERENCES kundalis(id),
  dosh_type TEXT NOT NULL,          -- condition code
  detected INTEGER NOT NULL DEFAULT 0,
  severity TEXT NOT NULL DEFAULT 'none' CHECK (severity IN ('none','low','medium','high')),
  confidence REAL,
  explanation TEXT DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '[]',   -- JSON array of rule-derived statements
  recommendation TEXT DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_dosh_kundali ON dosh_analysis(kundali_id, dosh_type);

CREATE TABLE IF NOT EXISTS puja_recommendations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kundali_id TEXT NOT NULL REFERENCES kundalis(id),
  puja_id TEXT REFERENCES pujas(id),
  recommendation_reason TEXT DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'secondary' CHECK (priority IN ('primary','secondary','optional')),
  relevance_score INTEGER NOT NULL DEFAULT 1,
  related_doshas TEXT NOT NULL DEFAULT '[]',  -- JSON array of condition codes
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_puja_reco_kundali ON puja_recommendations(kundali_id, priority);

-- Searchable birth-place index (city/state/country + coordinates + timezone).
CREATE TABLE IF NOT EXISTS place_index(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT NOT NULL,
  state TEXT DEFAULT '',
  country TEXT NOT NULL DEFAULT 'India',
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  tz TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  population INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_place_city ON place_index(city);
CREATE INDEX IF NOT EXISTS idx_place_city_country ON place_index(country, city);

-- Seed the place index with major Indian cities so search works on a fresh install.
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Mumbai','Maharashtra','India',19.0760,72.8777,'Asia/Kolkata',12442373 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Mumbai' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Delhi','Delhi','India',28.6139,77.2090,'Asia/Kolkata',16787941 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Delhi' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Bengaluru','Karnataka','India',12.9716,77.5946,'Asia/Kolkata',8443675 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Bengaluru' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Hyderabad','Telangana','India',17.3850,78.4867,'Asia/Kolkata',6809970 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Hyderabad' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Ahmedabad','Gujarat','India',23.0225,72.5714,'Asia/Kolkata',5577940 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Ahmedabad' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Chennai','Tamil Nadu','India',13.0827,80.2707,'Asia/Kolkata',4646732 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Chennai' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Kolkata','West Bengal','India',22.5726,88.3639,'Asia/Kolkata',4496694 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Kolkata' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Surat','Gujarat','India',21.1702,72.8311,'Asia/Kolkata',4467797 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Surat' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Pune','Maharashtra','India',18.5204,73.8567,'Asia/Kolkata',3124458 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Pune' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Jaipur','Rajasthan','India',26.9124,75.7873,'Asia/Kolkata',3046163 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Jaipur' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Lucknow','Uttar Pradesh','India',26.8467,80.9462,'Asia/Kolkata',2817105 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Lucknow' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Varanasi','Uttar Pradesh','India',25.3176,82.9739,'Asia/Kolkata',1198491 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Varanasi' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Kanpur','Uttar Pradesh','India',26.4499,80.3319,'Asia/Kolkata',2765348 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Kanpur' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Nagpur','Maharashtra','India',21.1458,79.0882,'Asia/Kolkata',2405665 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Nagpur' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Indore','Madhya Pradesh','India',22.7196,75.8577,'Asia/Kolkata',1960631 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Indore' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Bhopal','Madhya Pradesh','India',23.2599,77.4126,'Asia/Kolkata',1798218 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Bhopal' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Patna','Bihar','India',25.5941,85.1376,'Asia/Kolkata',1683200 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Patna' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Vadodara','Gujarat','India',22.3072,73.1812,'Asia/Kolkata',1602351 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Vadodara' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Coimbatore','Tamil Nadu','India',11.0168,76.9558,'Asia/Kolkata',1061447 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Coimbatore' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Kochi','Kerala','India',9.9312,76.2673,'Asia/Kolkata',601574 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Kochi' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Ujjain','Madhya Pradesh','India',23.1793,75.7849,'Asia/Kolkata',515215 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Ujjain' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Nashik','Maharashtra','India',19.9975,73.7898,'Asia/Kolkata',1486053 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Nashik' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Tirupati','Andhra Pradesh','India',13.6288,79.4192,'Asia/Kolkata',374260 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Tirupati' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Trimbakeshwar','Maharashtra','India',19.9363,73.5274,'Asia/Kolkata',12345 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Trimbakeshwar' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Haridwar','Uttarakhand','India',29.9457,78.1642,'Asia/Kolkata',228832 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Haridwar' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Gurugram','Haryana','India',28.4595,77.0266,'Asia/Kolkata',876824 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Gurugram' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Noida','Uttar Pradesh','India',28.5355,77.3910,'Asia/Kolkata',637272 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Noida' AND country='India');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'London','England','United Kingdom',51.5074,-0.1278,'Europe/London',8982000 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='London' AND country='United Kingdom');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'New York','New York','United States',40.7128,-74.0060,'America/New_York',8336817 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='New York' AND country='United States');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Dubai','Dubai','United Arab Emirates',25.2048,55.2708,'Asia/Dubai',3331400 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Dubai' AND country='United Arab Emirates');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Singapore','','Singapore',1.3521,103.8198,'Asia/Singapore',5685807 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Singapore' AND country='Singapore');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Sydney','New South Wales','Australia',-33.8688,151.2093,'Australia/Sydney',5312163 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Sydney' AND country='Australia');
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population)
  SELECT 'Kathmandu','','Nepal',27.7172,85.3240,'Asia/Kathmandu',1442271 WHERE NOT EXISTS(SELECT 1 FROM place_index WHERE city='Kathmandu' AND country='Nepal');

-- Extra condition types the flow supports from day one (mangal_dosha, kaal_sarp,
-- shani_dasha, pitru_dosha already exist from migration 002; align shani_dasha's
-- code to the rule registry with a new row rather than mutating old data).
INSERT OR IGNORE INTO kundali_conditions(code,name,descr,severity) VALUES
 ('grahan_dosha','Grahan Dosha','Eclipse-like combination: Sun or Moon with a lunar node','medium'),
 ('guru_chandal','Guru Chandal Yoga','Jupiter conjunct a lunar node','medium'),
 ('nadi_dosha','Nadi Dosha','Same-nadi combination between two charts (needs partner details)','medium'),
 ('shani_condition','Shani Condition','Sade Sati transit or a difficult natal Saturn','medium'),
 ('rahu_condition','Rahu Condition','Traditionally significant Rahu placement','medium'),
 ('ketu_condition','Ketu Condition','Traditionally significant Ketu placement','low');

-- Rule priority tier + editable reason text for condition -> puja mapping.
ALTER TABLE condition_puja_rules ADD COLUMN priority TEXT NOT NULL DEFAULT 'secondary';
ALTER TABLE condition_puja_rules ADD COLUMN reason TEXT NOT NULL DEFAULT '';

-- NOTE: kundali_profiles customer columns are added in 005; condition -> puja rule
-- rows and kund/samagri mappings are seeded in server/seed.js (seedKundaliCatalog),
-- because migrations run BEFORE the puja catalogue exists on a fresh database.
