-- 021_nri_packages.sql
-- Phase 13: NRI packages — fixed-price puja packages sold to the diaspora in
-- their own currency (USD default), mirroring the kundali commercial model:
-- a quoted total in a known currency, an idempotent checkout, one ledger row.
--
--   nri_packages  admin-managed catalogue: name, pitch, price in `currency`
--                 (default USD) with `inr_equiv` for INR ledger/display,
--                 `includes` JSON list of bullet points, active flag.
--   nri_orders    one row per purchase: PENDING_PAYMENT -> PAID (mock mode
--                 marks PAID immediately, exactly like kundali mock payments);
--                 idempotent per (idem key, user) through idempotency_keys.
--
-- Idempotency: same file-level transaction guarantee as 012–020 — the whole
-- file applies atomically or not at all, and schema_migrations prevents
-- re-application.

CREATE TABLE IF NOT EXISTS nri_packages(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  descr TEXT DEFAULT '',
  price INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  inr_equiv INTEGER NOT NULL,
  includes TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nri_packages_active ON nri_packages(active);

CREATE TABLE IF NOT EXISTS nri_orders(
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES nri_packages(id),
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  inr_equiv INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
  idem TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nri_orders_user ON nri_orders(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nri_orders_idem ON nri_orders(idem) WHERE idem IS NOT NULL;
