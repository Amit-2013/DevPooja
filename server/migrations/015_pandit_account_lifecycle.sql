-- 015_pandit_account_lifecycle.sql
-- Phase 22: standardized pandit account-status lifecycle on the SAME pandits row
-- (extension-first; the existing status values stay: pending/verified/rejected for
-- onboarding, plus the new lifecycle states under_review/suspended/terminated —
-- ACTIVE maps to 'verified').
--   account_reason        why (KYC issue, fraud concern, safety, complaint, …)
--   account_from / _to    suspension/hold window (ISO dates; _to optional)
--   account_review_date   when an admin must re-review
--   account_note          admin notes
-- Suspension/termination ALSO sets users.status (009) so login is enforced by the
-- existing mechanism, and the payout engine places open payouts ON_HOLD.
-- Idempotency: same file-level transaction guarantee as 008/012/013/014.

ALTER TABLE pandits ADD COLUMN account_reason TEXT;
ALTER TABLE pandits ADD COLUMN account_from TEXT;
ALTER TABLE pandits ADD COLUMN account_to TEXT;
ALTER TABLE pandits ADD COLUMN account_review_date TEXT;
ALTER TABLE pandits ADD COLUMN account_note TEXT;
