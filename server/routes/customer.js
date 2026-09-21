const router = require('express').Router();
const { db, tx, nextSeq } = require('../db');
const { requireRole, currentUser } = require('../auth');
const B = require('../services/bookings');
const pay = require('../services/payments');
const S = require('../lib/serialize');
const { v, bad, conflict, notFound, HttpError, today, j, rid, wrap } = require('../lib/util');
const { notify } = require('../services/notify');

router.use(requireRole('customer'));
const me = (req) => currentUser(req);

router.patch('/me', (req, res) => {
  const u = me(req), b = req.body;
  const name = b.name ? v.str(b.name, 'Name', { max: 80 }) : u.name;
  let email = u.email;
  if (b.email !== undefined && b.email !== '') { email = v.email(b.email); if (db.prepare('SELECT 1 FROM users WHERE email=? AND id!=?').get(email, u.id)) throw conflict('That email is already in use'); }
  const p = b.pref || {};
  const pref = { deity: v.str(p.deity, 'Deity', { optional: true, max: 40 }), lang: v.str(p.lang || 'English', 'Language', { max: 20 }), wa: !!p.wa, sms: !!p.sms, em: !!p.em };
  db.prepare('UPDATE users SET name=?, email=?, pref=? WHERE id=?').run(name, email, JSON.stringify(pref), u.id);
  res.json({ ok: true });
});
router.post('/me/addresses', (req, res) => {
  const u = me(req), a = j(u.addr, []);
  if (a.length >= 10) throw bad('You can save up to 10 addresses');
  a.push({ id: 'a' + rid(3), l: v.str(req.body.l || 'Address', 'Label', { max: 30 }), line: v.str(req.body.line, 'Address', { min: 3, max: 200 }), city: v.str(req.body.city, 'City', { max: 60 }), pin: v.str(req.body.pin, 'PIN', { optional: true, max: 6 }) });
  db.prepare('UPDATE users SET addr=? WHERE id=?').run(JSON.stringify(a), u.id);
  res.json({ ok: true });
});
router.delete('/me/addresses/:id', (req, res) => { const u = me(req); db.prepare('UPDATE users SET addr=? WHERE id=?').run(JSON.stringify(j(u.addr, []).filter((a) => a.id !== req.params.id)), u.id); res.json({ ok: true }); });
router.post('/me/family', (req, res) => {
  const u = me(req), f = j(u.fam, []);
  if (f.length >= 20) throw bad('You can save up to 20 family members');
  f.push({ id: 'f' + rid(3), n: v.str(req.body.n, 'Name', { max: 80 }), rel: v.str(req.body.rel || 'Family', 'Relation', { max: 30 }), gotra: v.str(req.body.gotra, 'Gotra', { optional: true, max: 40 }) });
  db.prepare('UPDATE users SET fam=? WHERE id=?').run(JSON.stringify(f), u.id);
  res.json({ ok: true });
});
router.delete('/me/family/:id', (req, res) => { const u = me(req); db.prepare('UPDATE users SET fam=? WHERE id=?').run(JSON.stringify(j(u.fam, []).filter((a) => a.id !== req.params.id)), u.id); res.json({ ok: true }); });
router.post('/me/plus', (req, res) => {
  if (pay.mode() !== 'mock') throw new HttpError(501, 'Plus checkout needs the payment gateway wired for subscriptions. See README.');
  db.prepare('UPDATE users SET plus=? WHERE id=?').run(req.body.on ? 1 : 0, me(req).id);
  res.json({ ok: true });
});

router.post('/bookings', wrap(async (req, res) => {
  const u = me(req);
  const row = B.createBooking(u, req.body);
  let payment = null;
  if (pay.mode() === 'razorpay') {
    try {
      payment = await pay.createOrder(S.booking(row).q.total, row.id);
      const p = j(row.pay, {}); p.orderId = payment.orderId;
      db.prepare('UPDATE bookings SET pay=? WHERE id=?').run(JSON.stringify(p), row.id);
    } catch (e) { B.cancelInternal(row, 0, 'Payment gateway error', false); throw new HttpError(502, 'Payment gateway error. Please try again.'); }
  }
  res.status(201).json({ booking: S.booking(B.getBooking(row.id)), payment });
}));
router.post('/payments/verify', (req, res) => { const row = B.confirmPayment(me(req), String(req.body.bookingId || ''), req.body); res.json({ booking: S.booking(row) }); });
router.post('/bookings/:id/cancel', (req, res) => res.json({ booking: S.booking(B.cancelBooking(me(req), req.params.id)) }));
router.post('/bookings/:id/reschedule', (req, res) => res.json({ booking: S.booking(B.rescheduleBooking(me(req), req.params.id, req.body)) }));
router.post('/bookings/:id/review', (req, res) => res.json({ booking: S.booking(B.reviewBooking(me(req), req.params.id, req.body)) }));

router.post('/orders', (req, res) => {
  const u = me(req), items = v.arr(req.body.items, 'Items', 30);
  if (!items.length) throw bad('Your cart is empty');
  const address = v.str(req.body.address, 'Delivery address', { min: 5, max: 200 }), city = v.str(req.body.city, 'City', { max: 60 });
  const id = 'OR' + nextSeq('order_seq', 1003);
  tx(() => {
    let sub = 0; const clean = [];
    for (const it of items) {
      const q = v.int(it.q, 'Quantity', { min: 1, max: 20 });
      const kit = db.prepare('SELECT * FROM kits WHERE id=?').get(it.k), pr = kit ? null : db.prepare('SELECT * FROM prasad WHERE id=?').get(it.k);
      if (!kit && !pr) throw bad('Unknown item');
      if (kit) { const r = db.prepare('UPDATE kits SET stock=stock-? WHERE id=? AND stock>=?').run(q, kit.id, q); if (!r.changes) throw conflict(kit.name + ' does not have enough stock'); }
      sub += (kit || pr).price * q; clean.push({ k: it.k, q });
    }
    const del = sub >= 999 || u.plus ? 0 : 49;
    db.prepare("INSERT INTO orders(id,user_id,items,total,date,status,city,address) VALUES(?,?,?,?,?,'Placed',?,?)").run(id, u.id, JSON.stringify(clean), sub + del, today(), city, address);
  })();
  notify(u.id, 'WhatsApp', `Order ${id} placed.`);
  res.status(201).json({ order: S.order(db.prepare('SELECT * FROM orders WHERE id=?').get(id)) });
});
router.post('/tickets', (req, res) => {
  const u = me(req), bid = v.str(req.body.b, 'Booking', { optional: true, max: 20 });
  if (bid && !db.prepare('SELECT 1 FROM bookings WHERE id=? AND user_id=?').get(bid, u.id)) throw notFound('Booking not found');
  const id = 'TK' + nextSeq('ticket_seq', 4);
  db.prepare("INSERT INTO tickets(id,user_id,booking_id,text,status,prio) VALUES(?,?,?,?,'Open','Medium')").run(id, u.id, bid || null, v.str(req.body.t, 'Issue', { max: 600 }));
  res.status(201).json({ ok: true, id });
});
module.exports = router;
