/* Browser-level smoke test: loads the real SPA from the real server in jsdom and drives the main flows.
   Run: node tests/ui-smoke.js   (needs `npm i -D jsdom`) */
process.env.NODE_ENV = 'test'; process.env.DEMO_MODE = 'true'; process.env.QUIET = '1'; process.env.JWT_SECRET = 't';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpui-'));
process.env.DB_PATH = path.join(tmp, 'u.db'); process.env.UPLOAD_DIR = path.join(tmp, 'up');
const { JSDOM, ResourceLoader } = require('jsdom');
const app = require('../server/index.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
class Loader extends ResourceLoader { fetch(url, o) { return url.startsWith('http://127.0.0.1') ? super.fetch(url, o) : Promise.resolve(Buffer.from('')); } }

(async () => {
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const dom = await JSDOM.fromURL(base, { runScripts: 'dangerously', resources: new Loader(), pretendToBeVisual: true,
    beforeParse(w) { w.scrollTo = () => {}; w.matchMedia = () => ({ matches: false }); w.FormData = FormData; w.Blob = Blob;
      w.fetch = (u, o) => fetch(new URL(u, base), o); w.addEventListener('error', (e) => errs.push('ERR ' + e.message)); } });
  const w = dom.window, d = w.document;
  const go = async (h) => { w.location.hash = h; await sleep(250); };
  const click = async (sel, ms = 250) => { const e = d.querySelector(sel); if (!e) { errs.push('MISSING ' + sel); return; } e.click(); await sleep(ms); };
  const setv = (id, v) => { const e = d.getElementById(id); if (!e) errs.push('NOID ' + id); else e.value = v; };
  const text = () => d.getElementById('view').textContent;
  for (let i = 0; i < 40 && !d.querySelector('#view h1'); i++) await sleep(100);
  console.log('home rendered:', /DeivikPooja|puja/i.test(text()));

  for (const r of ['', 'pujas', 'pujas?q=peace', 'puja/lakshmi', 'pandits', 'pandit/p1', 'temples', 'samagri', 'prasad', 'festivals', 'astrology', 'corporate', 'about', 'contact', 'partner', 'register-pandit', 'rewards', 'plus', 'account', 'portal', 'admin']) await go('#/' + r);

  // customer: login by OTP (new user)
  await click('[data-act=login]'); setv('ln', 'UI Tester'); setv('lm', '9123456789');
  await click('[data-act=sendotp]'); setv('lo', '123456'); await click('[data-act=verifyotp]', 500);
  console.log('logged in as customer:', /UI/.test(d.getElementById('hdr').textContent));
  // booking flow
  await go('#/book/satyanarayan'); await click('[data-act=wz-mode][data-v=home]');
  const dt = new Date(); dt.setDate(dt.getDate() + 25);
  const di = d.querySelector('[data-in=wz][data-k=date]'); di.value = dt.toISOString().slice(0, 10); di.dispatchEvent(new w.Event('change', { bubbles: true })); await sleep(100);
  await click('[data-act=wz-slot][data-v="10:00 AM"]'); setv; 
  const ad = d.querySelector('[data-in=wz][data-k="addr.line"]'); ad.value = '5 Test Lane'; ad.dispatchEvent(new w.Event('input', { bubbles: true }));
  await click('[data-act=wz-next]'); await click('[data-act=wz-pandit][data-v=p1]'); await click('[data-act=wz-next]');
  await click('[data-act=wz-sam]'); await click('[data-act=wz-next]');
  setv('cpn', 'DEIVIKPOOJA10'); await click('[data-act=wz-coupon]', 500); console.log('coupon msg:', /Coupon applied/.test(text()));
  await click('[data-act=wz-next]'); await click('[data-act=wz-pay]', 700);
  console.log('booking confirmed:', /Booking confirmed/.test(text()));
  for (const t of ['bookings', 'orders', 'notifs', 'profile', 'addresses', 'family', 'rewards', 'support']) await go('#/account/' + t);
  await go('#/account/bookings'); console.log('has booking card:', d.querySelectorAll('article.card').length);
  await click('[data-act=bres]'); await click('[data-act=close]'); await click('[data-act=binv]'); await click('[data-act=close]');
  await click('[data-act=bcan]'); await click('[data-act=bcanok]', 500); console.log('cancelled:', /Cancelled/.test(text()));
  await go('#/samagri'); await click('[data-act=cadd]'); await click('[data-act=cart]'); setv('cad', '9 Test Road'); await click('[data-act=corder]', 600);
  console.log('order placed:', /OR100\d/.test(text()));
  await click('[data-act=asst]'); setv('aq', 'I want peace and prosperity'); await click('[data-act=ask]', 500);
  console.log('guide reply:', /Lakshmi/.test(d.getElementById('msgs').textContent));
  await click('[data-act=logout]', 400);

  // pandit portal (demo)
  await go('#/partner'); await click('[data-act=demo-pandit]', 600);
  for (const t of ['dashboard', 'bookings', 'calendar', 'earnings', 'profile', 'growth']) await go('#/portal/' + t);
  await go('#/portal/bookings');
  await click('[data-act=pacc]', 500); await click('[data-act=pstart]', 500); await click('[data-act=pdone]');
  d.querySelectorAll('.dck').forEach((c) => { c.checked = true; }); await click('[data-act=pdoneok]', 700);
  console.log('portal completed booking:', /Completed/.test(text()));
  await go('#/portal/calendar'); await click('[data-act=poff]', 400);
  await click('[data-act=logout]', 400);

  // admin
  await go('#/admin'); await click('[data-act=alogin]', 600);
  for (const t of ['dashboard', 'bookings', 'pandits', 'pujas', 'customers', 'finance', 'marketing', 'ops', 'analytics', 'support']) await go('#/admin/' + t);
  await go('#/admin/bookings'); await click('[data-act=aman]'); setv('mn', 'Manual Cust'); setv('mm', '9000055555'); await click('[data-act=amanok]', 600);
  await go('#/admin/pandits'); await click('[data-act=akyc]', 500); await go('#/admin/finance'); await click('[data-act=acm]', 400);
  await go('#/admin/pujas'); setv('npn', 'Test Puja'); await click('[data-act=anp]', 500);
  console.log('admin puja added:', /Test Puja/.test(text()));
  console.log(errs.length ? errs.join('\n') : 'NO UI ERRORS');
  server.closeAllConnections(); server.close(); process.exit(errs.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
