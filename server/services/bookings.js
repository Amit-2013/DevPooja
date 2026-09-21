/* Booking business rules. Every rule the UI shows is enforced here; the browser is never trusted. */
const { db, tx, nextSeq, getSetting } = require('../db');
const P = require('../../shared/pricing');
const { j, iso, addDays, today, bad, forbidden, notFound, conflict, v } = require('../lib/util');
const { notify } = require('./notify');
const pay = require('./payments');

const STATUSES = ['New', 'Confirmed', 'Assigned', 'Started', 'Completed', 'Cancelled'];
const OPEN = ['New', 'Confirmed', 'Assigned'];
const log = (row, text) => { const l = j(row.log, []); l.push([text, today()]); return JSON.stringify(l); };
const getBooking = (id) => db.prepare('SELECT * FROM bookings WHERE id=?').get(id);

function expireUnpaid() {
  const rows = db.prepare("SELECT * FROM bookings WHERE status='PendingPayment' AND created < ?").all(Date.now() - 15 * 60 * 1000);
  rows.forEach((r) => cancelInternal(r, 0, 'Payment not completed', false));
}

function isFree(p, date, slot, skipId) {
  if (!p || p.status !== 'verified' || !p.avail) return false;
  if (j(p.off, []).includes(date)) return false;
  const c = db.prepare("SELECT 1 FROM bookings WHERE pandit_id=? AND date=? AND slot=? AND status NOT IN ('Cancelled') AND id != ?").get(p.id, date, slot, skipId || '');
  return !c;
}

function autoPick(pujaId, city, date, slot) {
  const list = db.prepare("SELECT * FROM pandits WHERE status='verified'").all().filter((p) => isFree(p, date, slot));
  list.sort((a, b) => (j(b.spec, []).includes(pujaId) - j(a.spec, []).includes(pujaId)) || ((b.city === city) - (a.city === city)) || b.rating - a.rating);
  return list[0] || null;
}

/* Validate the pricing-relevant parts of a request and return { puja, mode, pandit, kits, prasad, coupon, q, couponError } */
function priceRequest(userRow, body, { strictCoupon = true } = {}) {
  const puja = db.prepare('SELECT * FROM pujas WHERE id=? AND hidden=0').get(body.pujaId);
  if (!puja) throw notFound('Puja not found');
  const mode = v.oneOf(body.mode, Object.keys(P.MODES), 'Puja type');
  if (mode === 'temple') {
    const ok = db.prepare('SELECT pujas FROM temples').all().some((t) => j(t.pujas, []).includes(puja.id));
    if (!ok) throw bad('Temple puja is not available for this puja');
  }
  let pandit = null;
  if (body.panditId) { pandit = db.prepare("SELECT * FROM pandits WHERE id=? AND status='verified'").get(body.panditId); if (!pandit) throw bad('Pandit not available'); }
  const ids = (arr, name) => [...new Set(v.arr(arr, name))];
  const kits = ids(body.sam, 'Samagri').map((id) => { const k = db.prepare('SELECT * FROM kits WHERE id=?').get(id); if (!k) throw bad('Unknown samagri kit'); return k; });
  const prasad = ids(body.pra, 'Prasad').map((id) => { const k = db.prepare('SELECT * FROM prasad WHERE id=?').get(id); if (!k) throw bad('Unknown prasad item'); return k; });
  let coupon = null, couponError = '';
  if (body.coupon) {
    const c = db.prepare('SELECT * FROM coupons WHERE code=?').get(String(body.coupon).toUpperCase());
    coupon = c ? { code: c.code, type: c.type, val: c.val, max: c.max, min: c.min, active: !!c.active } : null;
  }
  const base = { puja: { price: puja.price }, pandit: pandit ? { pf: pandit.pf } : null, plus: !!(userRow && userRow.plus), kits: kits.map((k) => ({ price: k.price })), prasad: prasad.map((k) => ({ price: k.price })), points: userRow ? userRow.pts : 0, usePoints: !!body.usePoints && !!userRow };
  if (body.coupon) {
    const svc = P.quote(mode, { ...base, coupon: null, usePoints: false }).svc;
    couponError = P.couponProblem(coupon, svc);
    if (couponError) { if (strictCoupon) throw bad(couponError); coupon = null; }
  }
  const q = P.quote(mode, { ...base, coupon });
  return { puja, mode, pandit, kits, prasad, coupon, q, couponError };
}

function createBooking(user, body) {
  expireUnpaid();
  const date = v.date(body.date);
  if (date < addDays(1)) throw bad('Choose a date from tomorrow onwards');
  const slot = v.oneOf(body.slot, P.SLOTS, 'Time slot');
  const pr = priceRequest(user, body);
  const { puja, mode, kits, prasad, q } = pr;
  let addr = null, templeId = null;
  if (mode === 'temple') {
    const t = db.prepare('SELECT * FROM temples WHERE id=?').get(body.templeId);
    if (!t || !j(t.pujas, []).includes(puja.id)) throw bad('Choose a temple that offers this puja');
    templeId = t.id;
  } else {
    const a = body.addr || {};
    addr = { line: v.str(a.line || (mode === 'online' ? 'Online (video call)' : ''), 'Address', { min: 3, max: 200 }), city: v.str(a.city, 'City', { max: 60 }), pin: v.str(a.pin, 'PIN', { optional: true, max: 6 }) };
  }
  if (body.usePoints && q.pts > user.pts) throw bad('Not enough reward points');
  const member = v.str(body.member || 'Self', 'Member', { max: 80 });
  const notes = v.str(body.notes, 'Notes', { optional: true, max: 500 });
  const gateway = pay.mode() === 'razorpay';

  const run = tx(() => {
    let pandit = pr.pandit;
    if (pandit) { if (!isFree(pandit, date, slot)) throw conflict('That pandit is no longer free at this time. Choose another pandit or slot.'); }
    else pandit = autoPick(puja.id, addr && addr.city, date, slot);
    for (const k of kits) { const r = db.prepare('UPDATE kits SET stock=stock-1 WHERE id=? AND stock>0').run(k.id); if (!r.changes) throw conflict(k.name + ' is out of stock'); }
    if (q.pts) db.prepare('UPDATE users SET pts=pts-? WHERE id=?').run(q.pts, user.id);
    if (pr.coupon && q.disc) db.prepare('UPDATE coupons SET used=used+1 WHERE code=?').run(pr.coupon.code);
    const id = 'DP' + nextSeq('booking_seq', 2401);
    const status = gateway ? 'PendingPayment' : pandit ? 'Confirmed' : 'New';
    const payInfo = { method: gateway ? 'razorpay' : String(body.payMethod || 'UPI').slice(0, 20), ref: gateway ? '' : 'MOCK' + Math.floor(100000 + Math.random() * 900000), paid: !gateway };
    try {
      db.prepare(`INSERT INTO bookings(id,user_id,puja_id,mode,date,slot,addr,temple_id,pandit_id,pst,sam,pra,notes,member,coupon,q,status,pay,ops,media,created,log)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, user.id, puja.id, mode, date, slot, addr && JSON.stringify(addr), templeId, pandit ? pandit.id : null, pandit ? 'pending' : null,
        JSON.stringify(kits.map((k) => k.id)), JSON.stringify(prasad.map((k) => k.id)), notes, member, pr.coupon ? pr.coupon.code : '', JSON.stringify(q), status, JSON.stringify(payInfo),
        JSON.stringify({ sam: kits.length ? 'Packed' : '', pra: '' }), '[]', Date.now(), JSON.stringify([[gateway ? 'Awaiting payment' : 'Booking confirmed', today()]]));
    } catch (e) { if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw conflict('That pandit was just booked for this slot. Choose another.'); throw e; }
    return getBooking(id);
  });
  const row = run();
  if (!gateway) announce(row, user);
  return row;
}

function announce(row, user) {
  const p = db.prepare('SELECT name FROM pujas WHERE id=?').get(row.puja_id);
  const msg = `Booking ${row.id} confirmed: ${p.name} on ${row.date}, ${row.slot}.`;
  ['WhatsApp', 'SMS', 'Email'].forEach((ch) => notify(user.id, ch, msg));
}

function confirmPayment(user, id, { razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  const row = getBooking(id);
  if (!row || row.user_id !== user.id) throw notFound('Booking not found');
  const p = j(row.pay, {});
  if (p.paid) return row;
  if (row.status !== 'PendingPayment') throw bad('This booking is no longer awaiting payment');
  if (p.orderId !== razorpay_order_id || !pay.verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) throw bad('Payment verification failed');
  db.prepare('UPDATE bookings SET status=?, pay=?, log=? WHERE id=?').run(row.pandit_id ? 'Confirmed' : 'New', JSON.stringify({ ...p, paid: true, ref: razorpay_payment_id }), log(row, 'Payment received'), id);
  const out = getBooking(id);
  announce(out, user);
  return out;
}

function releaseResources(row) {
  const q = j(row.q, {}), ops = j(row.ops, {});
  if (q.pts) db.prepare('UPDATE users SET pts=pts+? WHERE id=?').run(q.pts, row.user_id);
  if (ops.sam !== 'Delivered') j(row.sam, []).forEach((id) => db.prepare('UPDATE kits SET stock=stock+1 WHERE id=?').run(id));
}

function cancelInternal(row, pct, reason, sendNotice = true) {
  const q = j(row.q, {}), paid = j(row.pay, {}).paid;
  const refund = paid && pct > 0 ? { amt: Math.round(q.total * pct / 100), pct, state: 'Initiated' } : null;
  tx(() => {
    db.prepare("UPDATE bookings SET status='Cancelled', refund=?, log=? WHERE id=?").run(refund && JSON.stringify(refund), log(row, reason), row.id);
    releaseResources(row);
  })();
  if (sendNotice) notify(row.user_id, 'Email', `Booking ${row.id} cancelled.` + (refund ? ` Refund of Rs ${refund.amt} initiated.` : ''));
  return getBooking(row.id);
}

function cancelBooking(user, id) {
  const row = getBooking(id);
  if (!row || row.user_id !== user.id) throw notFound('Booking not found');
  if (![...OPEN, 'PendingPayment'].includes(row.status)) throw bad('This booking can no longer be cancelled');
  return cancelInternal(row, P.refundPct(P.hoursUntil(row.date, row.slot)), 'Cancelled by customer');
}

function rescheduleBooking(user, id, body) {
  const row = getBooking(id);
  if (!row || row.user_id !== user.id) throw notFound('Booking not found');
  if (!OPEN.includes(row.status)) throw bad('This booking can no longer be rescheduled');
  const date = v.date(body.date);
  if (date < addDays(1)) throw bad('Choose a date from tomorrow onwards');
  const slot = v.oneOf(body.slot, P.SLOTS, 'Time slot');
  if (row.pandit_id) {
    const p = db.prepare('SELECT * FROM pandits WHERE id=?').get(row.pandit_id);
    if (!isFree(p, date, slot, row.id)) throw conflict('Your pandit is not free then. Try another slot.');
  }
  try { db.prepare('UPDATE bookings SET date=?, slot=?, log=? WHERE id=?').run(date, slot, log(row, 'Rescheduled'), id); }
  catch (e) { if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw conflict('Your pandit is not free then.'); throw e; }
  notify(user.id, 'SMS', `Booking ${id} rescheduled to ${date}, ${slot}.`);
  return getBooking(id);
}

function reviewBooking(user, id, body) {
  const row = getBooking(id);
  if (!row || row.user_id !== user.id) throw notFound('Booking not found');
  if (row.status !== 'Completed') throw bad('You can review a puja after it is completed');
  if (row.review) throw conflict('You have already reviewed this booking');
  const r = v.int(body.r, 'Rating', { min: 1, max: 5 });
  const t = v.str(body.t, 'Review', { optional: true, max: 500 }) || 'Good experience.';
  tx(() => {
    db.prepare('UPDATE bookings SET review=? WHERE id=?').run(JSON.stringify({ r, t, by: user.name, on: today() }), id);
    db.prepare('UPDATE users SET pts=pts+10 WHERE id=?').run(user.id);
    const p = row.pandit_id && db.prepare('SELECT rating,rev FROM pandits WHERE id=?').get(row.pandit_id);
    if (p) db.prepare('UPDATE pandits SET rating=?, rev=rev+1 WHERE id=?').run(Math.round(((p.rating * p.rev + r) / (p.rev + 1)) * 10) / 10, row.pandit_id);
  })();
  return getBooking(id);
}

function completeBooking(row, mediaUrls = []) {
  const q = j(row.q, {}), ops = j(row.ops, {});
  const comm = getSetting('commission', 20);
  if (j(row.sam, []).length) ops.sam = 'Delivered';
  if (j(row.pra, []).length || row.mode === 'temple') ops.pra = ops.pra || 'Dispatched';
  const media = [...j(row.media, []), ...mediaUrls];
  tx(() => {
    db.prepare("UPDATE bookings SET status='Completed', pst='accepted', ops=?, media=?, log=? WHERE id=?").run(JSON.stringify(ops), JSON.stringify(media), log(row, 'Completed'), row.id);
    db.prepare('UPDATE users SET pts=pts+? WHERE id=?').run(q.earn || 0, row.user_id);
    if (row.pandit_id) {
      db.prepare('UPDATE pandits SET done=done+1 WHERE id=?').run(row.pandit_id);
      const n = db.prepare('SELECT COUNT(*) c FROM payouts').get().c + 1;
      db.prepare('INSERT INTO payouts(id,pandit_id,amount,date,status,booking_id) VALUES(?,?,?,?,?,?)').run('PO' + n + '-' + row.id, row.pandit_id, Math.round(q.svc * (1 - comm / 100)), today(), 'Pending', row.id);
    }
  })();
  const name = db.prepare('SELECT name FROM pujas WHERE id=?').get(row.puja_id).name;
  notify(row.user_id, 'WhatsApp', `Your ${name} (${row.id}) is complete. Photos and certificate are ready. You earned ${q.earn || 0} points.`);
  return getBooking(row.id);
}

/* pandit actions */
function panditAct(pid, id, action, media) {
  const row = getBooking(id);
  if (!row || row.pandit_id !== pid) throw notFound('Booking not found');
  if (action === 'accept') {
    if (row.pst !== 'pending' || !OPEN.includes(row.status)) throw bad('Nothing to accept');
    db.prepare("UPDATE bookings SET pst='accepted', status='Assigned', log=? WHERE id=?").run(log(row, 'Pandit accepted'), id);
    notify(row.user_id, 'WhatsApp', `A pandit has accepted your booking ${id}.`);
  } else if (action === 'reject') {
    if (row.pst !== 'pending') throw bad('Only pending requests can be rejected');
    db.prepare("UPDATE bookings SET pandit_id=NULL, pst=NULL, status='New', log=? WHERE id=?").run(log(row, 'Pandit declined, reassigning'), id);
  } else if (action === 'start') {
    if (row.status !== 'Assigned') throw bad('Accept the booking before starting');
    db.prepare("UPDATE bookings SET status='Started', log=? WHERE id=?").run(log(row, 'Puja started'), id);
    notify(row.user_id, 'WhatsApp', `Your puja ${id} has started.`);
  } else if (action === 'complete') {
    if (row.status !== 'Started') throw bad('Start the puja before completing it');
    completeBooking(row, media);
  } else throw bad('Unknown action');
  return getBooking(id);
}

/* admin actions */
function adminAssign(id, pid) {
  const row = getBooking(id);
  if (!row) throw notFound('Booking not found');
  if (['Completed', 'Cancelled'].includes(row.status)) throw bad('This booking is closed');
  if (!pid) {
    db.prepare("UPDATE bookings SET pandit_id=NULL, pst=NULL, status=CASE WHEN status='Assigned' THEN 'Confirmed' ELSE status END, log=? WHERE id=?").run(log(row, 'Unassigned'), id);
  } else {
    const p = db.prepare('SELECT * FROM pandits WHERE id=?').get(pid);
    if (!p || !isFree(p, row.date, row.slot, id)) throw conflict('That pandit is not free at this time.');
    try { db.prepare("UPDATE bookings SET pandit_id=?, pst='pending', status=CASE WHEN status='New' THEN 'Confirmed' ELSE status END, log=? WHERE id=?").run(pid, log(row, 'Assigned to ' + p.name), id); }
    catch (e) { if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw conflict('That pandit is not free at this time.'); throw e; }
    notify(row.user_id, 'WhatsApp', `A pandit has been assigned to ${id}: ${p.name}.`);
  }
  return getBooking(id);
}
function adminStatus(id, status) {
  const row = getBooking(id);
  if (!row) throw notFound('Booking not found');
  v.oneOf(status, STATUSES, 'Status');
  if (row.status === status) return row;
  if (status === 'Completed') { if (row.status === 'Cancelled') throw bad('Cancelled bookings cannot be completed'); return completeBooking(row); }
  if (status === 'Cancelled') return cancelInternal(row, 100, 'Cancelled by admin');
  if (row.status === 'Completed' || row.status === 'Cancelled') throw bad('Closed bookings cannot be reopened');
  db.prepare('UPDATE bookings SET status=?, log=? WHERE id=?').run(status, log(row, status), id);
  notify(row.user_id, 'WhatsApp', `Booking ${id} is now ${status}.`);
  return getBooking(id);
}
function adminManual(body) {
  const name = v.str(body.name, 'Name', { max: 80 }), mobile = v.mobile(body.mobile);
  let u = db.prepare('SELECT * FROM users WHERE mobile=?').get(mobile);
  if (!u) {
    const id = 'u' + Date.now();
    db.prepare("INSERT INTO users(id,role,name,mobile,pts,plus,pref,addr,fam,joined,created_at) VALUES(?,'customer',?,?,0,0,'{}','[]','[]',?,?)").run(id, name, mobile, today(), Date.now());
    u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  }
  const mode = v.oneOf(body.mode, Object.keys(P.MODES), 'Type'), slot = v.oneOf(body.slot, P.SLOTS, 'Slot'), date = v.date(body.date);
  const pr = priceRequest(u, { pujaId: body.pujaId, mode, sam: [], pra: [] });
  const id = 'DP' + nextSeq('booking_seq', 2401);
  const temple = mode === 'temple' ? db.prepare('SELECT id,pujas FROM temples').all().find((t) => j(t.pujas, []).includes(pr.puja.id)) : null;
  db.prepare(`INSERT INTO bookings(id,user_id,puja_id,mode,date,slot,addr,temple_id,pandit_id,pst,sam,pra,notes,member,coupon,q,status,pay,ops,media,created,log)
    VALUES(?,?,?,?,?,?,?,?,NULL,NULL,'[]','[]',?,?,'',?,'New',?,'{}','[]',?,?)`).run(id, u.id, pr.puja.id, mode, date, slot, mode === 'temple' ? null : JSON.stringify({ line: 'Address to be confirmed', city: String(body.city || 'Delhi NCR'), pin: '' }),
    temple ? temple.id : null, 'Manual booking by admin', 'Self', JSON.stringify(pr.q), JSON.stringify({ method: 'Offline', ref: 'MAN' + Date.now().toString().slice(-6), paid: false }), Date.now(), JSON.stringify([['Manual booking created', today()]]));
  return getBooking(id);
}

module.exports = { STATUSES, isFree, priceRequest, createBooking, confirmPayment, cancelBooking, rescheduleBooking, reviewBooking, completeBooking, panditAct, adminAssign, adminStatus, adminManual, expireUnpaid, getBooking, cancelInternal };
