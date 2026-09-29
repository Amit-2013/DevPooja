-- 018_incident_reopen.sql
-- Phase 20 follow-up: reopening path for dismissed incidents.
--
-- Spec: DISMISSED is no longer fully terminal — an admin can reopen a dismissed
-- incident (it returns to UNDER_REVIEW) when new facts arrive, and the reopening
-- REASON is mandatory and audited. RESOLVED stays final: a resolution recorded
-- to the pandit is a committed outcome, not a parked one.
--
--   incidents.reopen_count   how many times this incident was reopened (0 for
--                            never) — surfaces in the admin support table so a
--                            repeatedly-reopened filing is visible at a glance
--   incidents.reopen_reason  the admin-supplied reason of the LATEST reopen
--                            (every individual reopen stays in audit_logs as
--                            incident.reopened with old→new status)
--
-- Idempotency: same file-level transaction guarantee as 012–017 — the whole
-- file applies atomically or not at all, and schema_migrations prevents
-- re-application (plain ALTER TABLE block per 015/016/017 convention).

ALTER TABLE incidents ADD COLUMN reopen_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE incidents ADD COLUMN reopen_reason TEXT;
