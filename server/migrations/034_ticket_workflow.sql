-- 034_ticket_workflow.sql
-- Phase 19 — complaints workflow: tickets move
--   OPEN → UNDER_REVIEW → PANDIT_RESPONSE → CUSTOMER_RESPONSE → DECISION → RESOLVED
-- with the admin driving every explicit transition (DECISION/RESOLVED need the
-- written note), while a pandit reply moves the ticket to PANDIT_RESPONSE and a
-- customer reply to CUSTOMER_RESPONSE themselves. Each reply is a
-- ticket_messages row that can carry evidence attachments reusing the
-- magic-checked media pipeline.
--
--   tickets.status     legacy 'Open'/'Resolved' backfilled to the new
--                       vocabulary (OPEN / RESOLVED); the new states ride the
--                       same TEXT column
--   tickets.resolution the admin decision/resolution text (required to reach
--                       DECISION or RESOLVED)
--   tickets.updated_at epoch-ms of the last transition or reply
--   ticket_messages    the conversation: one row per reply (customer, pandit
--                       or admin), attachments = JSON array of /media/ urls
--
-- ticket_messages shape change: 001 shipped a first-cut thread table
-- (id INTEGER AUTOINCREMENT, sender_role, sender_user_id, body, created_at)
-- that only ever held the 001 backfill — one copy of each ticket's subject.
-- CREATE TABLE IF NOT EXISTS would silently keep that old shape, so the table
-- is rebuilt in place: every historical message is carried over (ids prefixed
-- TM L so they can never collide with the TM<next_seq> ids the app writes),
-- with attachments defaulting to an empty list. Fresh installs run the same
-- path — the 001 backfill finds no tickets yet, so nothing is lost either way.
--
-- Idempotency: plain ALTER TABLE + UPDATE per the 015-033 convention;
-- schema_migrations prevents re-application. Atomic per file.

ALTER TABLE tickets ADD COLUMN updated_at INTEGER;
ALTER TABLE tickets ADD COLUMN resolution TEXT;

UPDATE tickets SET status='OPEN' WHERE status='Open';
UPDATE tickets SET status='RESOLVED' WHERE status='Resolved';

ALTER TABLE ticket_messages RENAME TO ticket_messages_legacy;

CREATE TABLE ticket_messages(
  id TEXT PRIMARY KEY,
  ticket_id TEXT,
  author_id TEXT,
  author_role TEXT,
  message TEXT,
  attachments TEXT,
  created INTEGER
);

INSERT INTO ticket_messages(id, ticket_id, author_id, author_role, message, attachments, created)
SELECT 'TML' || rowid, ticket_id, sender_user_id, sender_role, body, '[]', created_at
FROM ticket_messages_legacy;

DROP TABLE ticket_messages_legacy;

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id);
