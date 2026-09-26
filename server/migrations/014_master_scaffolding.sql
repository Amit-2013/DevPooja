-- 014_master_scaffolding.sql
-- Scaffolding tables for the remaining master-plan phases. These are CREATED
-- EMPTY (and stay unused by application code until their phase lands) so later
-- phases integrate against a real, migrated schema instead of inventing tables
-- mid-stream — but nothing existing changes behaviour.
--
-- NOTE ON NUMBERING: migrations 012 (audit + payout foundation) and 013
-- (availability calendar) already exist; this file continues the sequence.
--
-- Tables (master plan phase in brackets):
--   kyc_documents        [4]   per-document KYC records with status vocabulary
--   commission_tiers     [9]   tiered commission configuration
--   transactions         [10]  typed money ledger (SERVICE_PAYMENT/DAKSHINA/…)
--   incidents            [20]  pandit incident reporting
--   agreements           [23]  versioned agreement documents
--   agreement_acceptances [24] version-locked acceptance records
--   trial_poojas         [18]  pandit activation assessments
--
-- Idempotency: same file-level transaction guarantee as 008/012/013.

-- 1. KYC documents [Phase 4] ---------------------------------------------------
CREATE TABLE IF NOT EXISTS kyc_documents(
  id TEXT PRIMARY KEY,
  pandit_id TEXT NOT NULL REFERENCES pandits(id),
  doc_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  uploaded_at INTEGER NOT NULL,
  verified_by TEXT,
  verified_at INTEGER,
  reject_reason TEXT,
  expires_at INTEGER,
  next_reverification_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kycdoc_pandit ON kyc_documents(pandit_id);
CREATE INDEX IF NOT EXISTS idx_kycdoc_status ON kyc_documents(status);

-- 2. Commission tiers [Phase 9] -------------------------------------------------
CREATE TABLE IF NOT EXISTS commission_tiers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tier TEXT NOT NULL,
  service_category TEXT NOT NULL DEFAULT 'ALL',
  commission_pct INTEGER NOT NULL,
  pandit_share_pct INTEGER NOT NULL DEFAULT 0,
  effective_from TEXT,
  effective_to TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

-- 3. Transactions ledger [Phase 10] ----------------------------------------------
CREATE TABLE IF NOT EXISTS transactions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  user_id TEXT,
  pandit_id TEXT,
  booking_id TEXT,
  kundali_id TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  ref_table TEXT,
  ref_id TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txn_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_txn_pandit ON transactions(pandit_id);

-- 4. Incidents [Phase 20] ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS incidents(
  id TEXT PRIMARY KEY,
  pandit_id TEXT NOT NULL REFERENCES pandits(id),
  booking_id TEXT,
  customer_id TEXT,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'OPEN',
  admin_notes TEXT,
  resolution TEXT,
  reported_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_incident_pandit ON incidents(pandit_id);

-- 5. Agreements [Phases 23-25] ------------------------------------------------------
CREATE TABLE IF NOT EXISTS agreements(
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  document_hash TEXT,
  file_name TEXT,
  created_by TEXT,
  effective_from TEXT,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS agreement_acceptances(
  id TEXT PRIMARY KEY,
  agreement_id TEXT NOT NULL REFERENCES agreements(id),
  pandit_id TEXT NOT NULL REFERENCES pandits(id),
  method TEXT NOT NULL DEFAULT 'DIGITAL',
  otp_verified INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  device TEXT,
  accepted_at INTEGER NOT NULL,
  signature_ref TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_acceptance_version ON agreement_acceptances(agreement_id, pandit_id);

-- 6. Trial poojas [Phase 18] ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS trial_poojas(
  id TEXT PRIMARY KEY,
  pandit_id TEXT NOT NULL REFERENCES pandits(id),
  evaluator TEXT,
  date TEXT,
  service TEXT,
  punctuality INTEGER,
  communication INTEGER,
  ritual_compliance INTEGER,
  presentation INTEGER,
  customer_interaction INTEGER,
  digital_capability INTEGER,
  documentation INTEGER,
  final_score INTEGER,
  result TEXT NOT NULL DEFAULT 'PENDING',
  admin_notes TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trial_pandit ON trial_poojas(pandit_id);
