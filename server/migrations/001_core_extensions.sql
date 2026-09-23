-- 001_core_extensions.sql
-- Relational tables for data that previously lived only inside JSON columns.
-- Everything is idempotent and preserves all existing rows and IDs.

-- Money actually taken, previously implicit in bookings.pay JSON.
CREATE TABLE IF NOT EXISTS payments(
  id TEXT PRIMARY KEY,
  booking_id TEXT REFERENCES bookings(id),
  order_id TEXT REFERENCES orders(id),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  method TEXT NOT NULL,
  ref TEXT,
  state TEXT NOT NULL DEFAULT 'Pending' CHECK (state IN ('Pending','Paid','Failed','Refunded','Partially Refunded')),
  gateway TEXT NOT NULL DEFAULT 'mock',
  gateway_order_id TEXT,
  gateway_payment_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_state ON payments(state);

-- Bookings carry a review JSON column today; reviews becomes the queryable surface.
CREATE TABLE IF NOT EXISTS reviews(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  pandit_id TEXT REFERENCES pandits(id),
  puja_id TEXT NOT NULL REFERENCES pujas(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text TEXT DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_reviews_pandit ON reviews(pandit_id) WHERE hidden = 0;
CREATE INDEX IF NOT EXISTS idx_reviews_puja ON reviews(puja_id) WHERE hidden = 0;

INSERT INTO reviews(booking_id, user_id, pandit_id, puja_id, rating, text, hidden)
SELECT b.id, b.user_id, b.pandit_id, b.puja_id,
       json_extract(b.review, '$.r'), COALESCE(json_extract(b.review, '$.t'), ''),
       b.review_hidden
FROM bookings b
WHERE b.review IS NOT NULL AND json_valid(b.review)
ON CONFLICT(booking_id) DO NOTHING;

-- Audit trail for sensitive admin operations.
CREATE TABLE IF NOT EXISTS audit_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  detail TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_user_id);

-- Scheduled status changes were a bookings.log JSON array; now a queryable history.
CREATE TABLE IF NOT EXISTS booking_status_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  status TEXT NOT NULL,
  note TEXT DEFAULT '',
  actor_user_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_bsh_booking ON booking_status_history(booking_id, created_at);

INSERT INTO booking_status_history(booking_id, status, note, created_at)
SELECT b.id, b.status, 'imported from initial state', COALESCE(b.created, unixepoch() * 1000)
FROM bookings b
WHERE NOT EXISTS (SELECT 1 FROM booking_status_history h WHERE h.booking_id = b.id AND h.status = b.status);

-- Standalone samagri/prasad orders previously stored items as one JSON array.
CREATE TABLE IF NOT EXISTS order_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL DEFAULT 'kit' CHECK (kind IN ('kit','prasad')),
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0)
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

INSERT INTO order_items(order_id, kind, item_id, name, qty, unit_price)
SELECT o.id,
       CASE WHEN o.items LIKE '%k_%' THEN 'kit' ELSE 'kit' END,
       json_extract(v.value, '$.k'),
       COALESCE((SELECT name FROM kits WHERE id = json_extract(v.value, '$.k')), json_extract(v.value, '$.k')),
       json_extract(v.value, '$.q'),
       COALESCE((SELECT price FROM kits WHERE id = json_extract(v.value, '$.k')), 0)
FROM orders o, json_each(COALESCE(o.items, '[]')) v
WHERE json_valid(COALESCE(o.items, '[]'))
  AND json_extract(v.value, '$.k') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.item_id = json_extract(v.value, '$.k'));

-- Persistent cart, previously browser localStorage only.
CREATE TABLE IF NOT EXISTS cart_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'kit' CHECK (kind IN ('kit','prasad')),
  item_id TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE(user_id, kind, item_id)
);

-- Threaded support conversations; tickets.text was a single message.
CREATE TABLE IF NOT EXISTS ticket_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  sender_role TEXT NOT NULL CHECK (sender_role IN ('customer','pandit','admin')),
  sender_user_id TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id, created_at);

INSERT INTO ticket_messages(ticket_id, sender_role, sender_user_id, body, created_at)
SELECT t.id, 'customer', t.user_id, t.text, COALESCE(t.rowid * 1, unixepoch() * 1000)
FROM tickets t
WHERE NOT EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id = t.id);

-- Temples stored partner pujas as a JSON array; now a mapping table.
CREATE TABLE IF NOT EXISTS temple_pujas(
  temple_id TEXT NOT NULL REFERENCES temples(id),
  puja_id TEXT NOT NULL REFERENCES pujas(id),
  PRIMARY KEY (temple_id, puja_id)
);

INSERT INTO temple_pujas(temple_id, puja_id)
SELECT t.id, v.value
FROM temples t, json_each(COALESCE(t.pujas, '[]')) v
WHERE json_valid(COALESCE(t.pujas, '[]')) AND v.value IS NOT NULL
ON CONFLICT DO NOTHING;
