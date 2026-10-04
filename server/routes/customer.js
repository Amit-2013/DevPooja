const router = require('express').Router();
const { db, tx, nextSeq } = require('../db');
const { requireRole, currentUser } = require('../auth');
const B = require('../services/bookings');
const pay = require('../services/payments');
const S = require('../lib/serialize');
const { v, bad, conflict, notFound, HttpError, today, j, rid, wrap } = require('../lib/util');
const auditMod = require('../lib/audit');
const { notify } = require('../services/notify');
const P = require('../../shared/pricing');
const C = require('../services/coupons');

router.use(requireRole('customer'));
const me = (req) => currentUser(req);

/* Who can take this booking? Powers the wizard's available-pandit list with the
   SAME centralized availability rules the booking engine enforces (Phase 3). */
router.get('/pandits/available', (req, res) => {
  const AV = require('../services/availability');
  const date = v.date(req.query.date), slot = v.oneOf(req.query.slot, P.SLOTS, 'Time slot');
  const mode = req.query.mode && P.MODES[req.query.mode] ? req.query.mode : 'home';
  const pujaId = String(req.query.pujaId || '');
  const list = AV.whoIsAvailable(pujaId, req.query.city, date, slot, { mode }).map((p) => ({
    id: p.id, n: p.name, city: p.city, rating: p.rating, pf: p.pf, spec: j(p.spec, [])
  }));
  res.json({ pandits: list });
});

/* Profile location (additional-requirements Phase A): only the fields the app
   needs — city, country, optional coordinates captured with the user's
   permission, and how it was entered. Extra keys are ignored; junk
   coordinates/sources are rejected. An empty object clears the location. */
function locationShape(x) {
  const l = x || {};
  const coord = (n, min, max, label) => { if (n === undefined || n === null || n === '') return null; const c = Number(n); if (!Number.isFinite(c) || c < min || c > max) throw bad(label + ' is invalid'); return c; };
  const out = {
    city: v.str(l.city, 'City', { optional: true, max: 80 }),
    country: v.str(l.country, 'Country', { optional: true, max: 80 }),
    lat: coord(l.lat, -90, 90, 'Latitude'),
    lon: coord(l.lon, -180, 180, 'Longitude'),
    source: l.source ? v.oneOf(String(l.source).toLowerCase(), ['auto', 'manual'], 'Location source') : ''
  };
  if (!out.city && !out.country && out.lat === null && out.lon === null) return {};
  out.consentAt = Number.isFinite(+l.consentAt) ? +l.consentAt : Date.now();
  out.updatedAt = Date.now();
  return out;
}

/* Profile patch (existing) extended for Phase A: account-type switching and
   the optional location. Switching NEVER creates a second account or touches
   bookings/kundalis/orders/payments — it is a property of this same users
   row, and both changes are audited. */
router.patch('/me', (req, res) => {
  const u = me(req), b = req.body;
  const name = b.name ? v.str(b.name, 'Name', { max: 80 }) : u.name;
  let email = u.email;
  if (b.email !== undefined && b.email !== '') { email = v.email(b.email); if (db.prepare('SELECT 1 FROM users WHERE email=? AND id!=?').get(email, u.id)) throw conflict('That email is already in use'); }
  /* Notification preferences (item): pref is MERGED, never clobbered — a
     location-only PATCH must not wipe consent or the mute list. mute = 'all'
     or a subset of the five channels; absent behaves as before. */
  const prevPref = j(u.pref, {}) || {};
  const p = b.pref !== undefined && b.pref !== null ? b.pref : prevPref;
  const mute = p.mute === 'all' ? 'all'
    : Array.isArray(p.mute) ? p.mute.filter((c) => ['WhatsApp', 'Email', 'SMS', 'Push', 'In-App'].includes(String(c)))
      : [];
  const pref = Object.assign({}, prevPref, {
    deity: v.str(p.deity, 'Deity', { optional: true, max: 40 }), lang: v.str(p.lang || 'English', 'Language', { max: 20 }),
    wa: !!p.wa, sms: !!p.sms, em: !!p.em, mute
  });
  const prevType = u.account_type || 'normal';
  const accountType = (b.accountType === undefined || b.accountType === '') ? prevType : v.oneOf(String(b.accountType).toLowerCase(), ['normal', 'nri'], 'Account type');
  const location = b.location !== undefined ? locationShape(b.location) : j(u.location, {});
  db.prepare('UPDATE users SET name=?, email=?, pref=?, account_type=?, location=? WHERE id=?').run(name, email, JSON.stringify(pref), accountType, JSON.stringify(location), u.id);
  if (accountType !== prevType) auditMod.audit(u.id, 'user.account_type_switch', 'user', u.id, { from: prevType, to: accountType }, { reason: String(b.reason || '').slice(0, 200), oldValue: prevType, newValue: accountType });
  if (b.location !== undefined) auditMod.audit(u.id, 'user.location_update', 'user', u.id, { source: location.source || '', city: location.city || '' });
  res.json({ ok: true, accountType, location });
});
router.post('/me/addresses', (req, res) => {
  const u = me(req), a = j(u.addr, []);
  if (a.length >= 10) throw bad('You can save up to 10 addresses');
  a.push({ id: 'a' + rid(3), l: v.str(req.body.l || 'Address', 'Label', { max: 30 }), line: v.str(req.body.line, 'Address', { min: 3, max: 200 }), city: v.str(req.body.city, 'City', { max: 60 }), pin: v.str(req.body.pin, 'PIN', { optional: true, max: 6 }) });
  db.prepare('UPDATE users SET addr=? WHERE id=?').run(JSON.stringify(a), u.id);
  res.json({ ok: true });
});
router.delete('/me/addresses/:id', (req, res) => { const u = me(req); db.prepare('UPDATE users SET addr=? WHERE id=?').run(JSON.stringify(j(u.addr, []).filter((a) => a.id !== req.params.id)), u.id); res.json({ ok: true }); });
router.post('/me/plus', (req, res) => {
  if (pay.mode() !== 'mock') throw new HttpError(501, 'Plus checkout needs the payment gateway wired for subscriptions. See README.');
  db.prepare('UPDATE users SET plus=? WHERE id=?').run(req.body.on ? 1 : 0, me(req).id);
  res.json({ ok: true });
});

/* --- Family members (single source of truth: family_members table) ---------
   Replaces the legacy JSON blob on users.fam (still serialized into state under
   `fam` so the booking-wizard member picker keeps working). Family members are
   the subjects of separately chargeable kundali requests. */
const RELATIONSHIPS = ['Father', 'Mother', 'Spouse', 'Son', 'Daughter', 'Brother', 'Sister', 'Grandfather', 'Grandmother', 'Other'];

router.get('/me/family', (req, res) => {
  const rows = db.prepare('SELECT * FROM family_members WHERE customer_id=? ORDER BY created_at').all(me(req).id);
  res.json({ family: rows.map((f) => ({ id: f.id, relationship: f.relationship, name: f.name, gender: f.gender, dob: f.dob, tob: f.tob, birthPlace: f.birth_place, city: f.city, state: f.state, country: f.country, lat: f.lat, lon: f.lon, tz: f.tz, gotra: f.gotra, notes: f.notes, createdAt: f.created_at })) });
});

router.post('/me/family', (req, res) => {
  const b = req.body || {};
  const rel = v.oneOf(b.relationship || b.rel || 'Other', RELATIONSHIPS, 'Relationship');
  const name = v.str(b.name || b.n, 'Name', { max: 80 });
  if (db.prepare('SELECT COUNT(*) n FROM family_members WHERE customer_id=?').get(me(req).id).n >= 20) throw bad('You can save up to 20 family members');
  const id = 'fm' + rid(5);
  db.prepare(`INSERT INTO family_members(id,customer_id,relationship,name,gender,dob,tob,birth_place,city,state,country,lat,lon,tz,gotra,notes)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, me(req).id, rel, name,
      b.gender ? v.oneOf(b.gender, ['male', 'female', 'other'], 'Gender') : '',
      b.dob ? v.date(b.dob, 'Date of birth') : '',
      b.tob ? v.str(b.tob, 'Time of birth', { max: 8 }) : '',
      b.birthPlace ? v.str(b.birthPlace, 'Birth place', { max: 120, optional: true }) : '',
      b.city ? v.str(b.city, 'City', { max: 80, optional: true }) : '',
      b.state ? v.str(b.state, 'State', { max: 80, optional: true }) : '',
      b.country ? v.str(b.country, 'Country', { max: 80, optional: true }) : '',
      Number.isFinite(+b.lat) ? +b.lat : null, Number.isFinite(+b.lon) ? +b.lon : null,
      b.tz ? v.str(b.tz, 'Time zone', { max: 40, optional: true }) : '',
      (b.gotra || b.g) ? v.str(b.gotra || b.g, 'Gotra', { max: 40, optional: true }) : '',
      b.notes ? v.str(b.notes, 'Notes', { max: 400, optional: true }) : '');
  res.status(201).json({ ok: true, id });
});

router.patch('/me/family/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM family_members WHERE id=? AND customer_id=?').get(req.params.id, me(req).id);
  if (!f) throw notFound('Family member not found');
  const b = req.body || {};
  const rel = (b.relationship !== undefined || b.rel !== undefined) ? v.oneOf(b.relationship || b.rel, RELATIONSHIPS, 'Relationship') : f.relationship;
  const name = (b.name !== undefined || b.n !== undefined) ? v.str(b.name || b.n, 'Name', { max: 80 }) : f.name;
  db.prepare(`UPDATE family_members SET relationship=?, name=?, gender=?, dob=?, tob=?, birth_place=?, city=?, state=?, country=?, lat=?, lon=?, tz=?, gotra=?, notes=?, updated_at=datetime('now') WHERE id=?`)
    .run(rel, name,
      b.gender !== undefined ? (b.gender ? v.oneOf(b.gender, ['male', 'female', 'other'], 'Gender') : '') : f.gender,
      b.dob !== undefined ? (b.dob ? v.date(b.dob, 'Date of birth') : '') : f.dob,
      b.tob !== undefined ? (b.tob ? v.str(b.tob, 'Time of birth', { max: 8 }) : '') : f.tob,
      b.birthPlace !== undefined ? v.str(b.birthPlace, 'Birth place', { max: 120, optional: true }) : f.birth_place,
      b.city !== undefined ? v.str(b.city, 'City', { max: 80, optional: true }) : f.city,
      b.state !== undefined ? v.str(b.state, 'State', { max: 80, optional: true }) : f.state,
      b.country !== undefined ? v.str(b.country, 'Country', { max: 80, optional: true }) : f.country,
      b.lat !== undefined ? (Number.isFinite(+b.lat) ? +b.lat : null) : f.lat,
      b.lon !== undefined ? (Number.isFinite(+b.lon) ? +b.lon : null) : f.lon,
      b.tz !== undefined ? v.str(b.tz, 'Time zone', { max: 40, optional: true }) : f.tz,
      (b.gotra !== undefined || b.g !== undefined) ? v.str(b.gotra || b.g || '', 'Gotra', { max: 40, optional: true }) : f.gotra,
      b.notes !== undefined ? v.str(b.notes, 'Notes', { max: 400, optional: true }) : f.notes, f.id);
  res.json({ ok: true });
});

router.delete('/me/family/:id', (req, res) => {
  if (!/^fm[a-z0-9]+$/.test(req.params.id)) throw notFound('Family member not found');
  const r = db.prepare('DELETE FROM family_members WHERE id=? AND customer_id=?').run(req.params.id, me(req).id);
  if (!r.changes) throw notFound('Family member not found');
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
/* --- Phase 13: NRI packages — public catalogue + idempotent checkout.
   Deliberately NOT under /bookings: these are fixed-price currency packages
   (kundali-billing pattern), not pandit bookings — no slot, no payout engine. */
const NRI = require('../services/nri');
router.get('/nri-packages', (req, res) => res.json({ packages: NRI.listActive() }));
router.get('/nri-orders', (req, res) => res.json({ orders: NRI.ordersFor(req.auth.uid) }));
router.post('/nri-orders', wrap(async (req, res) => {
  let order = NRI.checkout(req.auth.uid, me(req).id, req.body || {});
  /* Gateway mode: attach a Razorpay order in the PACKAGE currency so
     checkout.js opens with the real price the customer was quoted. */
  let payment = null;
  if (order.status === 'PENDING_PAYMENT') {
    payment = await pay.createOrder(order.amount, order.id).catch((e) => { throw bad('Payment gateway error: ' + e.message); });
    tx(() => db.prepare('UPDATE nri_orders SET gateway_order_id=? WHERE id=?').run(payment.orderId, order.id))();
    order = { ...order, gatewayOrderId: payment.orderId };
  }
  res.status(201).json({ order, payment });
}));
/* Gateway money moment: verify the checkout signature, settle PAID, ledger once. */
router.post('/nri-orders/:id/verify', (req, res) => {
  res.json(NRI.verify(req.auth.uid, me(req).id, req.params.id, req.body || {}));
});
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
      if (kit) { if (!kit.active) throw bad(kit.name + ' is currently unavailable'); const r = db.prepare('UPDATE kits SET stock=stock-? WHERE id=? AND stock>=?').run(q, kit.id, q); if (!r.changes) throw conflict(kit.name + ' does not have enough stock'); }
      else { if (!pr.active) throw bad(pr.name + ' is currently unavailable'); if (pr.stock != null) { const r = db.prepare('UPDATE prasad SET stock=stock-? WHERE id=? AND stock>=?').run(q, pr.id, q); if (!r.changes) throw conflict(pr.name + ' does not have enough stock'); } }
      sub += (kit || pr).price * q; clean.push({ k: it.k, q });
    }
    const del = sub >= 999 || u.plus ? 0 : 49;
    /* Phase 14: the cart redeems ALL-scope coupons against the goods subtotal.
      Validation wording is shared with bookings/kundalis; delivery is charged
      on the post-coupon subtotal so a code can never create a negative cart. */
    let disc = 0, couponCode = '';
    if (req.body.coupon) {
      const { coupon, problem } = C.checkForOrder(req.body.coupon, u.id, sub);
      if (problem) throw bad(problem);
      disc = C.discountForOrder(coupon, sub);
      if (disc > 0) couponCode = coupon.code;
    }
    const after = Math.max(0, sub - disc);
    const del2 = after >= 999 || u.plus ? 0 : 49;
    db.prepare("INSERT INTO orders(id,user_id,items,total,date,status,city,address,coupon,discount) VALUES(?,?,?,?,?,'Placed',?,?,?,?)").run(id, u.id, JSON.stringify(clean), after + del2, today(), city, address, couponCode, disc);
    if (couponCode) { db.prepare('UPDATE coupons SET used=used+1 WHERE code=?').run(couponCode); C.recordRedemption(couponCode, u.id, 'order', id, disc); }
  })();
  notify(u.id, 'WhatsApp', `Order ${id} placed.`);
  res.status(201).json({ order: S.order(db.prepare('SELECT * FROM orders WHERE id=?').get(id)) });
});
/* Phase 14: live coupon check for the cart modal — same wording the order
   create will enforce, without reserving anything or touching stock. */
router.post('/orders/coupon', (req, res) => {
  const u = me(req);
  const code = v.str(req.body.code, 'Coupon code', { max: 20 });
  const items = v.arr(req.body.items || [], 'Items', 30);
  let sub = 0;
  for (const it of items) {
    const kit = db.prepare('SELECT * FROM kits WHERE id=?').get(it.k), pr = kit ? null : db.prepare('SELECT * FROM prasad WHERE id=?').get(it.k);
    if (kit || pr) sub += (kit || pr).price * v.int(it.q || 1, 'Quantity', { min: 1, max: 20 });
  }
  const { coupon, problem } = C.checkForOrder(code, u.id, sub);
  if (problem) return res.json({ code, problem });
  res.json({ code: coupon.code, problem: '', discount: C.discountForOrder(coupon, sub) });
});
router.post('/tickets', (req, res) => {
  const u = me(req), bid = v.str(req.body.b, 'Booking', { optional: true, max: 20 });
  if (bid && !db.prepare('SELECT 1 FROM bookings WHERE id=? AND user_id=?').get(bid, u.id)) throw notFound('Booking not found');
  const id = 'TK' + nextSeq('ticket_seq', 4);
  db.prepare("INSERT INTO tickets(id,user_id,booking_id,text,status,prio) VALUES(?,?,?,?,'Open','Medium')").run(id, u.id, bid || null, v.str(req.body.t, 'Issue', { max: 600 }));
  res.status(201).json({ ok: true, id });
});
module.exports = router;
