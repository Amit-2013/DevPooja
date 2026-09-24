-- 008_commercial_kundali.sql
-- Commercial Kundali model + workflow extensions. Idempotent (guarded ALTERs /
-- CREATE IF NOT EXISTS). English and Hindi content from earlier migrations is
-- untouched; existing kundalis keep working (billing columns default to FREE).

-- 1. Family members (separately chargeable kundali subjects) ------------------
CREATE TABLE IF NOT EXISTS family_members(
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id),
  relationship TEXT NOT NULL,
  name TEXT NOT NULL,
  gender TEXT DEFAULT '',
  dob TEXT DEFAULT '',
  tob TEXT DEFAULT '',
  birth_place TEXT DEFAULT '',
  city TEXT DEFAULT '',
  state TEXT DEFAULT '',
  country TEXT DEFAULT '',
  lat REAL,
  lon REAL,
  tz TEXT DEFAULT '',
  photo TEXT DEFAULT '',
  gotra TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_family_customer ON family_members(customer_id);

-- 2. Kundali billing columns ---------------------------------------------------
ALTER TABLE kundalis ADD COLUMN customer_id TEXT;
ALTER TABLE kundalis ADD COLUMN family_member_id TEXT;
ALTER TABLE kundalis ADD COLUMN relationship TEXT DEFAULT '';
ALTER TABLE kundalis ADD COLUMN billing TEXT NOT NULL DEFAULT 'FREE';
ALTER TABLE kundalis ADD COLUMN price INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kundalis ADD COLUMN discount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kundalis ADD COLUMN gst INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kundalis ADD COLUMN final_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kundalis ADD COLUMN currency TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE kundalis ADD COLUMN payment_id TEXT DEFAULT '';
ALTER TABLE kundalis ADD COLUMN order_id TEXT DEFAULT '';
ALTER TABLE kundalis ADD COLUMN payment_status TEXT DEFAULT '';
ALTER TABLE kundalis ADD COLUMN idem_key TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_kundali_customer ON kundalis(customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kundali_idem ON kundalis(idem_key) WHERE idem_key != '';

-- 3. Idempotency keys (payments, generation, webhooks) -------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys(
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL
);

-- 4. Export audit log (admin, report, filters, count) --------------------------
CREATE TABLE IF NOT EXISTS export_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT NOT NULL,
  report TEXT NOT NULL,
  filters TEXT DEFAULT '',
  rows INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL
);

-- 5. Puja master extensions (common master for HOME/ONLINE/TEMPLE/CUSTOMIZED) --
ALTER TABLE pujas ADD COLUMN occasion TEXT DEFAULT '';
ALTER TABLE pujas ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pujas ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;

-- 6. Customized Puja requests: extended workflow -------------------------------
-- The 007 table has a CHECK constraint on the short status set, so it is rebuilt
-- with the full spec workflow. Old statuses are mapped forward.
CREATE TABLE IF NOT EXISTS custom_requests_new(
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  name TEXT NOT NULL,
  mobile TEXT NOT NULL,
  language TEXT DEFAULT '',
  requirement TEXT DEFAULT '',
  purpose TEXT DEFAULT '',
  deity TEXT DEFAULT '',
  occasion TEXT DEFAULT '',
  preferred_date TEXT DEFAULT '',
  preferred_time TEXT DEFAULT '',
  location TEXT DEFAULT '',
  city TEXT DEFAULT '',
  state TEXT DEFAULT '',
  country TEXT DEFAULT '',
  participants INTEGER,
  budget INTEGER,
  kundali_id TEXT DEFAULT '',
  dosh_condition TEXT DEFAULT '',
  remedy TEXT DEFAULT '',
  sankalp TEXT DEFAULT '',
  samagri_req TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  attachments TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN (
    'NEW','UNDER_REVIEW','PANDIT_CONSULTATION','QUOTE_PREPARED','CUSTOMER_APPROVAL_PENDING',
    'APPROVED','PAYMENT_PENDING','PAID','PANDIT_ASSIGNED','TEMPLE_ASSIGNED','SCHEDULED',
    'IN_PROGRESS','COMPLETED','REJECTED','CANCELLED','EXPIRED','REFUNDED')),
  admin_notes TEXT DEFAULT '',
  pandit_notes TEXT DEFAULT '',
  quote_amount INTEGER,
  final_price INTEGER,
  payment_status TEXT DEFAULT '',
  assigned_pandit_id TEXT,
  assigned_temple_id TEXT,
  booking_id TEXT DEFAULT '',
  history TEXT NOT NULL DEFAULT '[]',
  admin_note TEXT DEFAULT '',
  puja_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
INSERT INTO custom_requests_new(id,user_id,name,mobile,purpose,deity,preferred_date,city,budget,notes,
    status,admin_notes,admin_note,puja_id,created_at,updated_at,history)
  SELECT id,user_id,name,mobile,purpose,deity,preferred_date,city,budget,notes,
    CASE status
      WHEN 'New' THEN 'NEW' WHEN 'Contacted' THEN 'UNDER_REVIEW' WHEN 'Quoted' THEN 'QUOTE_PREPARED'
      WHEN 'Booked' THEN 'SCHEDULED' WHEN 'Closed' THEN 'CANCELLED' ELSE 'NEW' END,
    COALESCE(admin_note,''), COALESCE(admin_note,''), puja_id, created_at, updated_at, '[]'
  FROM custom_requests;
DROP TABLE custom_requests;
ALTER TABLE custom_requests_new RENAME TO custom_requests;
CREATE INDEX IF NOT EXISTS idx_custom_requests_status ON custom_requests(status);
