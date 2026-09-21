/* Shared pricing and rules: loaded by the Node server (require) and by the browser (<script>).
   This is the single source of truth for how a booking is priced. The server always recomputes. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Pricing = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MODES = {
    home:   { n: 'Home Puja',         i: '🏠', f: 1,   d: 'The pandit comes to your home' },
    online: { n: 'Online Video Puja', i: '📹', f: 0.7, d: 'Live video call with your sankalp read out' },
    temple: { n: 'Temple Puja',       i: '🛕', f: 0.9, d: 'Performed at a partner temple on your behalf' },
    custom: { n: 'Customized Puja',   i: '🎨', f: 1.4, d: 'Extended rituals, special mantras, your own requirements' }
  };
  const SLOTS = ['06:00 AM', '08:00 AM', '10:00 AM', '12:00 PM', '02:00 PM', '04:00 PM', '06:00 PM'];
  const TEMPLE_OFFERING = 251, CONVENIENCE_FEE = 99, DELIVERY_FEE = 49, FREE_DELIVERY_ABOVE = 999;
  const GST_SERVICE = 0.18, GST_GOODS = 0.05, POINT_VALUE = 0.5, MAX_POINTS_SHARE = 0.3;

  /* ctx: { puja, pandit|null, plus:boolean, kits:[{price}], prasad:[{price}], coupon|null, points:number(user balance), usePoints:boolean } */
  function quote(mode, ctx) {
    const puja = ctx.puja, pd = ctx.pandit;
    const svc = Math.round((puja.price * MODES[mode].f * (pd ? pd.pf : 1)) / 10) * 10;
    const tmp = mode === 'temple' ? TEMPLE_OFFERING : 0;
    const plus = !!ctx.plus;
    const conv = plus ? 0 : CONVENIENCE_FEE;
    const sam = (ctx.kits || []).reduce((a, k) => a + k.price, 0);
    const pra = (ctx.prasad || []).reduce((a, k) => a + k.price, 0);
    const del = sam + pra > 0 && !plus && sam + pra < FREE_DELIVERY_ABOVE ? DELIVERY_FEE : 0;
    let disc = 0;
    const c = ctx.coupon;
    if (c && c.active && svc >= c.min) disc = Math.round(c.type === 'pct' ? Math.min((svc * c.val) / 100, c.max) : c.val);
    let rd = 0, pts = 0;
    if (ctx.usePoints && ctx.points > 0) {
      rd = Math.round(Math.min(ctx.points * POINT_VALUE, (svc - disc) * MAX_POINTS_SHARE));
      pts = Math.round(rd / POINT_VALUE);
    }
    const base = svc + tmp + conv - disc - rd;
    const gst = Math.round(base * GST_SERVICE + (sam + pra) * GST_GOODS);
    const total = base + sam + pra + del + gst;
    return { svc, tmp, conv, sam, pra, del, disc, rd, pts, gst, total, earn: Math.floor(total / 100) * (plus ? 2 : 1) };
  }

  function couponProblem(c, svc) {
    if (!c || !c.active) return 'Coupon not found or inactive.';
    if (svc < c.min) return 'Needs a puja value of at least Rs ' + c.min + '.';
    return '';
  }

  /* Refund tier by hours before the puja: >48h 100%, 24-48h 75%, otherwise 50% */
  function refundPct(hoursToPuja) { return hoursToPuja > 48 ? 100 : hoursToPuja > 24 ? 75 : 50; }

  function slotDate(date, slot) {
    const m = slot.match(/(\d+):(\d+) (AM|PM)/);
    const h = (+m[1] % 12) + (m[3] === 'PM' ? 12 : 0);
    const d = new Date(date + 'T12:00:00');
    d.setHours(h, +m[2], 0, 0);
    return d;
  }
  function hoursUntil(date, slot, now) { return (slotDate(date, slot) - (now || new Date())) / 36e5; }

  return { MODES, SLOTS, TEMPLE_OFFERING, CONVENIENCE_FEE, quote, couponProblem, refundPct, slotDate, hoursUntil };
});
