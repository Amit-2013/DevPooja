/* Static, read-only backend for the GitHub Pages build.

   tools/build-pages.js copies this file into the published artifact only, so running the
   app on a server (`npm start`) always talks to the real Express + SQLite API.

   Every page still renders from genuine data: demo/<role>.json is captured at build time
   by calling the real server's buildState() for each role. Nothing here writes back.
   A static host has no database, and saying so is more honest than pretending to save. */
window.PagesDemo = (function () {
  'use strict';

  const DIR = 'demo/';
  const ROLES = ['anon', 'customer', 'pandit', 'admin'];
  const DEMO_OTP = '123456';
  const DEFAULT_REPO = 'https://github.com/Amit-2013/DevPooja';

  const snapshots = {};
  let role = 'anon', config = null, banner = false;

  try {
    const saved = JSON.parse(localStorage.getItem('dp_demo_role') || '"anon"');
    if (ROLES.indexOf(saved) > -1) role = saved;
  } catch (e) { /* private mode: fall back to anonymous */ }

  function get(name) {
    return fetch(DIR + name, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error('This build is missing ' + DIR + name + '. Run `npm run build:pages`.');
      return r.json();
    });
  }
  const stateOf = (r) => (snapshots[r] = snapshots[r] || get(r + '.json'));
  const cfg = () => (config = config || get('config.json'));
  const softCfg = () => cfg().catch(() => null);

  function remember(k, v) {
    try { v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
  /* core.js clears dp_token on logout, so the saved role only applies while signed in. */
  function signedIn() { try { return !!localStorage.getItem('dp_token'); } catch (e) { return false; } }
  function setRole(r) { role = r; remember('dp_demo_role', r); }
  function login(r) { setRole(r); return { token: 'demo-' + r, role: r }; }

  /* Why a write could not be saved, phrased for the thing the visitor just tried to do. */
  function blocked(path) {
    const clone = 'Clone the repo and run `npm start` to use it for real.';
    if (/^\/(bookings|payments|orders)/.test(path)) return 'Booking, payments and orders need the Express + SQLite API, which a static host cannot run. ' + clone;
    if (/^\/admin\//.test(path)) return 'The admin panel is read-only in this Pages demo, so nothing was saved. ' + clone;
    if (/^\/pandit\//.test(path)) return 'Pandit portal actions are read-only in this Pages demo, so nothing was saved. ' + clone;
    if (/^\/me/.test(path)) return 'Accounts are read-only in this Pages demo, so your change was not saved. ' + clone;
    return 'This is a read-only demo, so nothing was saved. ' + clone;
  }

  /* Same rules the server applies: shared/pricing.js is the one source of truth for money. */
  function quote(body, conf) {
    const mode = Pricing.MODES[body.mode] ? body.mode : 'home';
    const puja = PUJAS.find((p) => p.id === body.pujaId);
    if (!puja) throw new Error('Puja not found');
    const pd = db && body.panditId ? PD(body.panditId) : null;
    const u = me();
    const pick = (ids, list) => (ids || []).map((id) => list.find((x) => x.id === id)).filter(Boolean).map((x) => ({ price: x.p }));
    const ctx = {
      puja: { price: puja.price }, pandit: pd ? { pf: pd.pf } : null, plus: !!(u && u.plus),
      kits: pick(body.sam, KITS), prasad: pick(body.pra, PRASAD),
      points: u ? u.pts : 0, usePoints: !!body.usePoints && !!u
    };
    let coupon = null, couponError = '';
    if (body.coupon) {
      const c = ((conf && conf.coupons) || []).find((x) => x.code === String(body.coupon).toUpperCase());
      coupon = c ? { code: c.code, type: c.type, val: c.val, max: c.max, min: c.min, active: !!c.active } : null;
      const svc = Pricing.quote(mode, Object.assign({}, ctx, { coupon: null, usePoints: false })).svc;
      couponError = Pricing.couponProblem(coupon, svc);
      if (couponError) coupon = null;
    }
    return { q: Pricing.quote(mode, Object.assign({}, ctx, { coupon })), couponError, coupon };
  }

  async function adminLogin(body) {
    const conf = await softCfg();
    const email = String(body.email || '').trim().toLowerCase();
    if (!conf || !conf.admin || email !== conf.admin.email || String(body.password || '') !== conf.admin.password) {
      throw Object.assign(new Error('Incorrect credentials'), { status: 401 });
    }
    return login('admin');
  }

  async function request(path, o) {
    const body = (o && o.body) || {};
    if (path === '/state') { showBanner(await softCfg()); return stateOf(signedIn() ? role : 'anon'); }
    if (path === '/quote') return quote(body, await softCfg());
    if (path === '/auth/demo') return login(body.role === 'pandit' ? 'pandit' : 'customer');
    if (path === '/auth/otp/send') return { ok: true, devOtp: DEMO_OTP };
    if (path === '/auth/otp/verify') return login(body.as === 'pandit' ? 'pandit' : 'customer');
    if (path === '/auth/email') return login('customer');
    if (path === '/auth/admin') return adminLogin(body);
    if (path === '/leads') return { ok: true };   /* an enquiry form: nothing to lose by accepting it */
    throw new Error(blocked(path));
  }

  /* Explains the demo once, and stays out of the way: bottom left, so the cart, the guide
     button and the toasts keep their corners. */
  function showBanner(conf) {
    if (banner || !document.body || document.getElementById('dp-demo')) return;
    banner = true;
    try { if (sessionStorage.getItem('dp-demo-off') === '1') return; } catch (e) {}
    const repo = (conf && conf.repo) || DEFAULT_REPO;
    const when = conf && conf.generated ? new Date(conf.generated).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const style = document.createElement('style');
    style.textContent = '#dp-demo{position:fixed;left:18px;bottom:18px;z-index:70;max-width:min(360px,calc(100vw - 36px));background:var(--card);color:var(--ink);border:1px solid var(--line);border-left:4px solid var(--gold);border-radius:10px;padding:12px 34px 12px 14px;font-size:.84rem;line-height:1.45;box-shadow:0 8px 28px rgba(0,0,0,.28)}'
      + '#dp-demo b{display:block}#dp-demo a{color:var(--pri);text-decoration:underline}'
      + '#dp-demo button{position:absolute;top:2px;right:6px;background:none;border:0;font-size:1.3rem;line-height:1;cursor:pointer;color:var(--mut)}'
      + '@media(max-width:640px){#dp-demo{left:12px;right:12px;bottom:12px;max-width:none}}';
    document.head.appendChild(style);
    const el = document.createElement('div');
    el.id = 'dp-demo';
    el.setAttribute('role', 'status');
    el.innerHTML = '<button aria-label="Dismiss this notice">&times;</button><b>Read-only demo</b>'
      + 'A snapshot of the seeded database' + (when ? ' from ' + esc(when) : '') + '. Browsing, pricing and demo logins work; booking, payments and admin edits need the API. '
      + '<a href="' + repo + '" rel="noopener">Run it locally</a>.';
    el.querySelector('button').addEventListener('click', () => {
      el.remove();
      try { sessionStorage.setItem('dp-demo-off', '1'); } catch (e) {}
    });
    document.body.appendChild(el);
  }

  return { request };
})();
