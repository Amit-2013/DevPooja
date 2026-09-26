/* Builds the role-scoped state object the browser app renders from. Customers only ever receive their own data. */
const { db, getSetting } = require('../db');
const S = require('./serialize');
const { j } = require('./util');
const pay = require('../services/payments');
const { expireUnpaid } = require('../services/bookings');

const mask = (m) => (m ? m.slice(0, 2) + 'XXXXXX' + m.slice(-2) : '');

function buildState(auth) {
  expireUnpaid();
  const role = auth && auth.role;
  const kits = db.prepare('SELECT * FROM kits').all();
  const pujaRows = db.prepare(role === 'admin' ? 'SELECT * FROM pujas' : 'SELECT * FROM pujas WHERE hidden=0').all();
  const kitItems = Object.fromEntries(kits.map((k) => [k.id, j(k.items, [])]));

  const st = {
    session: auth ? { role, uid: auth.uid, pid: auth.pid || null } : null,
    config: { paymentMode: pay.mode(), razorpayKeyId: pay.mode() === 'razorpay' ? process.env.RAZORPAY_KEY_ID : null, demo: String(process.env.DEMO_MODE || (process.env.NODE_ENV === 'production' ? 'false' : 'true')) === 'true' },
    catalog: {
      pujas: pujaRows.map((r) => S.puja(r, kitItems[r.kit])), kits: kits.map(S.kit),
      prasad: db.prepare('SELECT * FROM prasad').all().map(S.prasad), temples: db.prepare('SELECT * FROM temples').all().map(S.temple),
      festivals: db.prepare('SELECT * FROM festivals ORDER BY date').all().map(S.festival)
    },
    banners: db.prepare('SELECT * FROM banners WHERE enabled=1').all().map((b) => ({ id: b.id, t: b.text, on: true })),
    kundali: { enabled: true, purposes: ['General', 'Marriage', 'Career', 'Business', 'Health & Wellness', 'Finance', 'Education', 'Family', 'Child', 'Spiritual', 'Property', 'Other'] },
    toggles: (() => { try { const r = db.prepare("SELECT value FROM settings WHERE key='service_toggles'").get(); return Object.assign({ home: true, online: true, temple: true, customized: true, kundali: true, pandit: true, templeDir: true, prasad: true, samagri: true, astrology: true }, r ? JSON.parse(r.value) : {}); } catch (e) { return {}; } })(),
    pandits: [], busy: [], reviews: [],
    me: null, users: [], bookings: [], orders: [], notifs: [], tickets: [], coupons: [], payouts: [], inv: {}, campaigns: [], leads: [], set: {}, hidden: []
  };

  const pRows = db.prepare('SELECT * FROM pandits').all();
  st.pandits = pRows.filter((p) => role === 'admin' || p.status === 'verified' || (role === 'pandit' && p.id === auth.pid)).map((p) => S.pandit(p, { admin: role === 'admin', self: role === 'pandit' && p.id === auth.pid }));
  st.busy = db.prepare("SELECT id, pandit_id p, date, slot FROM bookings WHERE pandit_id IS NOT NULL AND status NOT IN ('Cancelled')").all();
  st.reviews = db.prepare("SELECT b.pandit_id pid, b.review, b.puja_id FROM bookings b WHERE b.review IS NOT NULL AND b.review_hidden=0 AND b.pandit_id IS NOT NULL").all()
    .map((r) => { const rv = j(r.review, {}); return { pid: r.pid, r: rv.r, t: rv.t, by: rv.by, puja: r.puja_id }; });

  if (role === 'customer') {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(auth.uid);
    st.me = S.user(u); st.users = [st.me];
    /* Family members live in the family_members table (single source of truth);
       `fam` keeps its legacy shape for the booking-wizard member picker. */
    st.me.fam = db.prepare('SELECT * FROM family_members WHERE customer_id=? ORDER BY created_at').all(u.id)
      .map((f) => ({ id: f.id, n: f.name, rel: f.relationship, gotra: f.gotra }));
    st.family = db.prepare('SELECT * FROM family_members WHERE customer_id=? ORDER BY created_at').all(u.id)
      .map((f) => ({ id: f.id, relationship: f.relationship, name: f.name, gender: f.gender, dob: f.dob, tob: f.tob, birthPlace: f.birth_place, city: f.city, state: f.state, country: f.country, lat: f.lat, lon: f.lon, tz: f.tz, gotra: f.gotra, notes: f.notes, createdAt: f.created_at }));
    st.myKundalis = db.prepare('SELECT id,name,relationship,billing,price,gst,final_amount,payment_status,order_id,created_at FROM kundalis WHERE customer_id=? ORDER BY created_at DESC').all(u.id)
      .map((k) => ({ kundaliId: k.id, name: k.name, relationship: k.relationship || 'Self', billing: k.billing, price: k.price, gst: k.gst, final: k.final_amount, paymentStatus: k.payment_status, orderId: k.order_id, createdAt: k.created_at }));
    st.bookings = db.prepare("SELECT * FROM bookings WHERE user_id=? AND status != 'PendingPayment' ORDER BY created DESC").all(u.id).map(S.booking);
    st.orders = db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY date DESC').all(u.id).map(S.order);
    st.notifs = db.prepare('SELECT * FROM notifs WHERE user_id=? ORDER BY ts DESC LIMIT 100').all(u.id).map((n) => ({ id: n.id, uid: n.user_id, ch: n.channel, m: n.message, ts: n.ts }));
    st.tickets = db.prepare('SELECT * FROM tickets WHERE user_id=? ORDER BY rowid DESC').all(u.id).map(S.ticket);
  } else if (role === 'pandit') {
    st.bookings = db.prepare("SELECT * FROM bookings WHERE pandit_id=? AND status != 'PendingPayment' ORDER BY date").all(auth.pid).map(S.booking);
    const ids = [...new Set(st.bookings.map((b) => b.userId))];
    st.users = ids.map((id) => db.prepare('SELECT id,name,mobile FROM users WHERE id=?').get(id)).filter(Boolean).map((u) => ({ id: u.id, n: u.name, m: mask(u.mobile), e: '', pts: 0, plus: false, addr: [], fam: [], pref: {}, joined: '' }));
    st.payouts = db.prepare('SELECT * FROM payouts WHERE pandit_id=?').all(auth.pid).map(S.payout);
    st.set = { comm: getSetting('commission', 20) };
  } else if (role === 'admin') {
    st.bookings = db.prepare("SELECT * FROM bookings WHERE status != 'PendingPayment' ORDER BY created DESC").all().map(S.booking);
    st.users = db.prepare("SELECT * FROM users WHERE role='customer'").all().map(S.user);
    st.orders = db.prepare('SELECT * FROM orders ORDER BY date DESC').all().map(S.order);
    st.tickets = db.prepare('SELECT * FROM tickets ORDER BY rowid DESC').all().map(S.ticket);
    st.coupons = db.prepare('SELECT * FROM coupons').all().map(S.coupon);
    st.payouts = db.prepare('SELECT * FROM payouts').all().map(S.payout);
    st.inv = Object.fromEntries(kits.map((k) => [k.id, k.stock]));
    st.campaigns = db.prepare('SELECT * FROM campaigns').all().map((c) => ({ id: c.id, n: c.name, ch: c.channel, aud: c.audience, st: c.status, sent: c.sent }));
    st.leads = db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 200').all().map((l) => ({ type: l.type, n: l.name, d: l.details, date: l.date }));
    st.set = { comm: getSetting('commission', 20) };
    st.hidden = db.prepare('SELECT id FROM bookings WHERE review_hidden=1').all().map((r) => r.id);
    st.banners = db.prepare('SELECT * FROM banners').all().map((b) => ({ id: b.id, t: b.text, on: !!b.enabled }));
  }
  return st;
}
module.exports = { buildState };
