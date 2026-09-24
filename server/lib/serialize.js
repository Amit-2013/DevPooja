/* Row -> API shape. The browser app uses these short field names. */
const { j } = require('./util');

const user = (r) => r && ({ id: r.id, n: r.name, m: r.mobile || '', e: r.email || '', pts: r.pts, plus: !!r.plus, addr: j(r.addr, []), fam: j(r.fam, []), pref: j(r.pref, {}), joined: r.joined });
const pandit = (r, { admin = false } = {}) => r && ({
  id: r.id, n: r.name, city: r.city, exp: r.exp, langs: j(r.langs, []), spec: j(r.spec, []), rating: r.rating, rev: r.rev, done: r.done,
  pf: r.pf, bio: r.bio || '', color: r.color || '#0c4b49', st: r.status, feat: !!r.featured, off: j(r.off, []), avail: !!r.avail,
  ...(admin ? { m: r.mobile, kyc: Object.keys(j(r.kyc, {}).files || {}) } : {})
});
const booking = (r) => {
  const media = j(r.media, []);
  return {
    id: r.id, userId: r.user_id, pujaId: r.puja_id, mode: r.mode, date: r.date, slot: r.slot, addr: j(r.addr, null), templeId: r.temple_id,
    panditId: r.pandit_id, pst: r.pst, sam: j(r.sam, []), pra: j(r.pra, []), notes: r.notes || '', member: r.member || 'Self', coupon: r.coupon || '',
    q: j(r.q, {}), status: r.status, pay: j(r.pay, {}), ops: j(r.ops, {}), media: media.length, mediaUrls: media, review: j(r.review, null),
    created: r.created, log: j(r.log, []), refund: j(r.refund, null), esc: !!r.esc
  };
};
const puja = (r, kitItems) => ({ id: r.id, n: r.name, h: r.hindi, cat: r.cat, ic: r.icon, dur: r.dur, price: r.price, deity: r.deity, ben: r.ben, benHi: r.ben_hi || '', kit: r.kit, pop: r.pop, tags: r.tags, hidden: !!r.hidden, sam: kitItems || [] });
const kit = (r) => ({ id: r.id, n: r.name, p: r.price, ic: r.icon, items: j(r.items, []), active: r.active === undefined ? 1 : r.active });
const prasad = (r) => ({ id: r.id, n: r.name, p: r.price, ic: r.icon, d: r.descr, stock: r.stock === undefined ? null : r.stock, active: r.active === undefined ? 1 : r.active });
const temple = (r) => ({ id: r.id, n: r.name, city: r.city, deity: r.deity, ic: r.icon, pujas: j(r.pujas, []), off: r.offering, d: r.descr });
const festival = (r) => ({ id: r.id, n: r.name, d: r.date, p: j(r.pujas, []), t: r.note });
const order = (r) => ({ id: r.id, userId: r.user_id, items: j(r.items, []), total: r.total, date: r.date, st: r.status, city: r.city });
const ticket = (r) => ({ id: r.id, userId: r.user_id, b: r.booking_id || '', t: r.text, st: r.status, prio: r.prio });
const payout = (r) => ({ id: r.id, p: r.pandit_id, amt: r.amount, date: r.date, st: r.status, b: r.booking_id });
const coupon = (r) => ({ code: r.code, type: r.type, val: r.val, max: r.max, min: r.min, active: !!r.active, used: r.used });

module.exports = { user, pandit, booking, puja, kit, prasad, temple, festival, order, ticket, payout, coupon };
