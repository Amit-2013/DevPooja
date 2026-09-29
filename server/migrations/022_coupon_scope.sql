-- 022_coupon_scope.sql
-- Phase 14: coupons become first-class across every paid surface.
--
--   scope        ALL (default — every surface incl. the cart) | PUJA (puja
--                bookings only) | KUNDALI (kundali purchases only)
--   puja_id      optional per-puja restriction within the PUJA scope
--   starts       epoch ms when the coupon becomes valid (NULL = already)
--   expires      epoch ms when the coupon lapses (NULL = never)
--   per_user     max redemptions per user (0 = unlimited)
--   coupon_redemptions(code, user_id)  one row per redemption, recorded at the
--                money moment: booking payment confirmation, kundali paid
--                (mock settle or gateway /pay/verify) and cart order placement.
--                This is what per_user counts; `used` stays the global counter.
--   orders.coupon + discount   the cart (shop orders) can now redeem ALL-scope
--                coupons; bookings/kundalis keep their own columns.
--
-- Existing codes backfill to scope='ALL' — historical behaviour is preserved
-- exactly (they were redeemable everywhere and nowhere was restricted).
--
-- Idempotency: plain ALTER TABLE block per 015–021 convention; schema_migrations
-- prevents re-application. Whole file applies atomically or not at all.

ALTER TABLE coupons ADD COLUMN scope TEXT NOT NULL DEFAULT 'ALL';
ALTER TABLE coupons ADD COLUMN puja_id TEXT;
ALTER TABLE coupons ADD COLUMN starts INTEGER;
ALTER TABLE coupons ADD COLUMN expires INTEGER;
ALTER TABLE coupons ADD COLUMN per_user INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS coupon_redemptions(
  code TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,              -- booking | kundali | order
  ref_id TEXT NOT NULL,              -- booking id / kundali id / order id
  amount INTEGER NOT NULL DEFAULT 0, -- rupees discounted at the money moment
  created INTEGER NOT NULL,
  PRIMARY KEY(code, user_id, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_user ON coupon_redemptions(user_id);

ALTER TABLE orders ADD COLUMN coupon TEXT DEFAULT '';
ALTER TABLE orders ADD COLUMN discount INTEGER NOT NULL DEFAULT 0;

-- Kundali rows keep their own `discount` (008); store which coupon produced it
-- so kundali redemptions can be tied to the purchase.
ALTER TABLE kundalis ADD COLUMN coupon TEXT DEFAULT '';

-- Historical coupons were redeemable everywhere; keep them that way.
UPDATE coupons SET scope='ALL' WHERE scope IS NULL OR scope='';
