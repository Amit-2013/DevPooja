/* Row -> API shape. The browser app uses these short field names. */
const { j } = require('./util');
const PE = require('../services/payoutEngine');
const AV = require('../services/availability');

/* `accountType`/`location` (additional-requirements Phase A, migration 029):
   NRI is a property of the SAME customer account, and the profile location
   carries only what the app needs (city, country, optional coordinates, how
   they were captured). */
const user = (r) => r && ({ id: r.id, n: r.name, m: r.mobile || '', e: r.email || '', pts: r.pts, plus: !!r.plus, addr: j(r.addr, []), fam: j(r.fam, []), pref: j(r.pref, {}), joined: r.joined, accountType: r.account_type || 'normal', location: j(r.location, {}) });
const pandit = (r, { admin = false, self = false, flagged = false } = {}) => r && ({
  id: r.id, n: r.name, city: r.city, exp: r.exp, langs: j(r.langs, []), spec: j(r.spec, []), rating: r.rating, rev: r.rev, done: r.done,
  pf: r.pf, bio: r.bio || '', color: r.color || '#0c4b49', st: r.status, feat: !!r.featured, off: j(r.off, []), avail: !!r.avail,
  photo: r.photo_file ? '/media/' + r.photo_file : '', gotra: r.gotra || '', quals: r.qualifications || '', veda: r.veda_school || '',
  qa: r.qa_score === undefined || r.qa_score === null ? null : r.qa_score,
  /* derived cancellation/no-show metrics are NOT inlined here (they need their own
     queries); both backends expose them on the dedicated QA endpoints
     (/admin/pandits/:id/qa, /pandit/me/qa) which the portals use. */
  ...(admin ? { m: r.mobile, kyc: Object.keys(j(r.kyc, {}).files || {}), flagged: !!flagged } : {}),
  ...(self || admin ? { av: AV.configOf(r) } : {})
});
const booking = (r) => {
  const media = j(r.media, []);
  return {
    id: r.id, userId: r.user_id, pujaId: r.puja_id, mode: r.mode, date: r.date, slot: r.slot, addr: j(r.addr, null), templeId: r.temple_id,
    panditId: r.pandit_id, pst: r.pst, sam: j(r.sam, []), pra: j(r.pra, []), notes: r.notes || '', member: r.member || 'Self', coupon: r.coupon || '',
    q: j(r.q, {}), status: r.status, pay: j(r.pay, {}), ops: j(r.ops, {}), media: media.length, mediaUrls: media, review: j(r.review, null),
    created: r.created, log: j(r.log, []), refund: j(r.refund, null), esc: !!r.esc, mediaOverride: !!r.media_override,
    /* Per-pandit flagging follow-up: bookings of flagged pandits wait under a review hold. */
    reviewHold: !!r.review_hold, holdReason: r.hold_reason || null,
    /* Customer-conduct escalation: soft review flag on new bookings of flagged customers. */
    ch: r.customer_hold || 0, chr: r.customer_hold_reason || null
  };
};
const puja = (r, kitItems) => ({ id: r.id, n: r.name, h: r.hindi, cat: r.cat, ic: r.icon, dur: r.dur, price: r.price, deity: r.deity, ben: r.ben, benHi: r.ben_hi || '', kit: r.kit, pop: r.pop, tags: r.tags, hidden: !!r.hidden, sam: kitItems || [],
  /* Phase 11: per-mode prices (null = legacy formula) + bookable modes */
  priceHome: r.price_home != null ? r.price_home : null, priceOnline: r.price_online != null ? r.price_online : null, priceTemple: r.price_temple != null ? r.price_temple : null, priceCustom: r.price_custom != null ? r.price_custom : null, modes: (() => { try { const m = JSON.parse(r.modes || '[]'); return Array.isArray(m) && m.length ? m : ['home', 'online', 'temple', 'custom']; } catch (e) { return ['home', 'online', 'temple', 'custom']; } })() });
const kit = (r) => ({ id: r.id, n: r.name, p: r.price, ic: r.icon, items: j(r.items, []), active: r.active === undefined ? 1 : r.active });
const prasad = (r) => ({ id: r.id, n: r.name, p: r.price, ic: r.icon, d: r.descr, stock: r.stock === undefined ? null : r.stock, active: r.active === undefined ? 1 : r.active });
const temple = (r) => ({ id: r.id, n: r.name, city: r.city, deity: r.deity, ic: r.icon, pujas: j(r.pujas, []), off: r.offering, d: r.descr, active: r.active === undefined || r.active === null ? 1 : r.active, timings: r.timings || '', photo: r.photo || '' });
const festival = (r) => ({ id: r.id, n: r.name, d: r.date, p: j(r.pujas, []), t: r.note });
const order = (r) => ({ id: r.id, userId: r.user_id, items: j(r.items, []), total: r.total, date: r.date, st: r.status, city: r.city, coupon: r.coupon || '', discount: r.discount || 0 });
const ticket = (r) => ({ id: r.id, userId: r.user_id, b: r.booking_id || '', t: r.text, st: r.status, prio: r.prio });
/* Payout shape: canonical statuses (Phases 7-8), hold info, money trail, refs.
   `hr` is what a pandit sees for WHY a payout is on hold; refs are admin-only via
   the detail endpoint, but harmless here since only admins/pandit-own rows flow. */
const payout = (r) => ({ id: r.id, p: r.pandit_id, amt: r.amount, date: r.date,
  st: PE.legacyStatus(r.status), b: r.booking_id,
  gross: r.gross_amount != null ? r.gross_amount : r.amount, comm: r.commission_amt,
  tax: r.tax_amt || 0, refd: r.refund_amt || 0, adj: r.adjustment_amt || 0,
  cur: r.currency || 'INR', hr: r.hold_reason || null, hn: r.hold_note || null,
  pd: r.processing_date || null, dd: r.disbursement_date || null, pr: r.payment_ref || null, utr: r.utr || null });
const coupon = (r) => ({ code: r.code, type: r.type, val: r.val, max: r.max, min: r.min, active: !!r.active, used: r.used, scope: r.scope || 'ALL', pujaId: r.puja_id || null, starts: r.starts || null, expires: r.expires || null, per_user: r.per_user || 0 });
/* Phase 26: compact CRM lead row for the admin state payload. */
const lead = (r) => ({ id: r.id, type: r.type, n: r.name, details: r.details || '', date: r.date,
  mobile: r.mobile || '', email: r.email || '', service: r.service || '', location: r.location || '',
  st: r.status || 'NEW', assignedTo: r.assigned_to || null, followUpAt: r.follow_up_at || null,
  convertedBookingId: r.converted_booking_id || null,
  dupCount: r.dup_count || 0, lastDupAt: r.last_dup_at || null });

module.exports = { user, pandit, booking, puja, kit, prasad, temple, festival, order, ticket, payout, coupon, lead };
