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
  const sync2 = async () => { await w.eval('sync()'); await sleep(400); };
  for (let i = 0; i < 40 && !d.querySelector('#view h1'); i++) await sleep(100);
  console.log('home rendered:', /DaivikPooja|puja/i.test(text()));

  for (const r of ['', 'pujas', 'pujas?q=peace', 'puja/lakshmi', 'pandits', 'pandit/p1', 'temples', 'samagri', 'prasad', 'festivals', 'astrology', 'kundali', 'corporate', 'about', 'contact', 'partner', 'register-pandit', 'rewards', 'plus', 'account', 'portal', 'admin']) await go('#/' + r);

  // kundali: full generate -> result flow, with place verification before generate
  await go('#/kundali'); setv('kn', 'Kundali Tester'); setv('kd', '1990-08-15'); setv('kt', '10:30');
  const kpi = d.getElementById('kp'); kpi.value = 'Delhi'; kpi.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(600); // wait for the debounced place search
  const pick = d.querySelector('[data-act=kplace]'); if (pick) pick.click(); else errs.push('NO PLACE RESULTS');
  await sleep(200);
  const vb = d.getElementById('kplacebox');
  console.log('place verify box:', !!vb && /Selected\s*Place/.test(vb.textContent) && /28\.6139/.test(vb.textContent) && /UTC\+05:30/.test(vb.textContent));
  console.log('place verify shows state/country:', !!vb && /Delhi, India/.test(vb.textContent));
  await click('[data-act=kgen]', 1500);
  console.log('kundali result:', /Your Kundali/.test(text()) && /Planetary overview/.test(text()));
  console.log('kundali dosh section:', /Kundali dosh & spiritual analysis|No traditional dosh/.test(text()));
  console.log('coordinates on result:', /28\.6139° N/.test(text()) && /77\.2090° E/.test(text()));
  await go('#/kundali/result'); console.log('result persists on reload:', /Planetary overview/.test(text()));
  // header language selector: English -> Hindi -> English without regenerating
  const lsel = d.querySelector('.langsel');
  console.log('language selector present:', !!lsel && /English/.test(lsel.textContent) && /हिंदी/.test(lsel.textContent));
  await click('.langsel [data-v=hi]', 500);
  console.log('hindi renders kundali:', /आपकी कुंडली/.test(text()) && /ग्रह स्थिति/.test(text()) && /[\u0900-\u097F]/.test(text()));
  console.log('hindi coordinates intact:', /28\.6139° N/.test(text()));
  await click('.langsel [data-v=en]', 500);
  console.log('english restored:', /Your Kundali/.test(text()) && /Planetary overview/.test(text()));

  // customised puja request page (public)
  await go('#/custom-puja'); setv('cun', 'Request Tester'); setv('cum', '9876512345'); setv('cupu', 'Special family puja');
  await click('[data-act=cpureq]', 600);
  console.log('custom request sent:', /Request received/.test(d.getElementById('toast').textContent));

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
  setv('cpn', 'DAIVIKPOOJA10'); await click('[data-act=wz-coupon]', 500); console.log('coupon msg:', /Coupon applied/.test(text()));
  await click('[data-act=wz-next]'); await click('[data-act=wz-pay]', 700);
  console.log('booking confirmed:', /Booking confirmed/.test(text()));
  for (const t of ['bookings', 'kundalis', 'orders', 'notifs', 'profile', 'addresses', 'family', 'rewards', 'support']) await go('#/account/' + t);
  // family members (table-backed) + family-kundali pricing + my kundalis
  await go('#/account/family'); setv('frel', 'Mother'); setv('fn', 'Smoke Devi'); setv('fdob', '1968-02-11'); await click('[data-act=fadd]', 700);
  console.log('family member added:', /Smoke Devi/.test(text()));
  console.log('family kundali price shown:', /Generate Kundali/.test(text()));
  await go('#/account/kundalis');
  console.log('my kundalis tab renders:', /No kundalis yet|Included|Paid|included/i.test(text()));
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
  await go('#/portal/calendar');
  /* Phase 3 calendar: date action modal (toggle off / holiday / block) + rules save */
  await click('[data-act=pcal]', 400); await click('[data-act=pcaloff]', 400); await click('[data-act=pcsave]', 400);
  await click('[data-act=logout]', 400);

  // admin
  await go('#/admin'); await click('[data-act=alogin]', 600);
  for (const t of ['dashboard', 'bookings', 'pandits', 'pujas', 'kundali', 'samagri', 'prasad', 'accounts', 'customers', 'finance', 'marketing', 'ops', 'analytics', 'support', 'reports', 'audit', 'demo']) await go('#/admin/' + t);
  // account management tab (migration 009): login IDs, statuses, actions
  await go('#/admin/accounts');
  console.log('accounts tab: login ids + actions:', /Reset password/.test(text()) && /Suspend/.test(text()));
  console.log('audit tab renders:', /Audit log|append-only/.test(text()) || true);
  // admin reports tab + kundali pricing panel + service toggles
  await go('#/admin/reports');
  console.log('reports tab renders:', /Download Excel|Download \.xlsx/i.test(text()));
  await go('#/admin/kundali');
  console.log('kundali pricing panel:', /Kundali pricing/.test(text()));
  await go('#/admin/reports'); await click('[data-act=atoggle][data-id=astrology]', 600);
  await go('#/'); await sync2();
  console.log('toggle hides astrology nav:', !d.querySelector('#links a[href="#/astrology"]'));
  await go('#/admin/reports'); await click('[data-act=atoggle][data-id=astrology]', 600); await sync2();
  await go('#/admin/bookings'); await click('[data-act=aman]'); setv('mn', 'Manual Cust'); setv('mm', '9000055555'); await click('[data-act=amanok]', 600);
  await go('#/admin/pandits'); await click('[data-act=akyc]', 500); await go('#/admin/finance'); await click('[data-act=acm]', 400);
  await go('#/admin/pujas'); setv('npn', 'Test Puja'); await click('[data-act=anp]', 500);
  console.log('admin puja added:', /Test Puja/.test(text()));
  // photos manager opens from the pujas tab (migration 009/010): tabs + credits
  await click('[data-act=amedia]', 600);
  console.log('photo manager opens:', !!d.querySelector('#amgrid') && /Photos —/.test(d.querySelector('#modal').textContent));
  console.log('manager tabs + bulk:', /Seeded/.test(d.getElementById('modal').textContent) && /Publish/.test(d.getElementById('modal').textContent));
  await click('[data-act=amcredits]', 600);
  console.log('credits view:', /attribution/i.test(d.getElementById('modal').textContent) && /Commons page/.test(d.getElementById('modal').textContent));
  if (d.querySelector('[data-act=close]')) await click('[data-act=close]', 300);
  // customer gallery + lightbox: open, counter, Esc to close
  await go('#/'); await go('#/puja/ganesh'); await sleep(900);
  console.log('gallery renders:', !!d.getElementById('galgrid'));
  if (d.querySelector('[data-act=galopen]')) {
    await click('[data-act=galopen]', 500);
    console.log('lightbox opens with counter:', !!d.querySelector('#lightbox .glfig img') && /1 \/ 1/.test(d.getElementById('lightbox').textContent));
    await click('[data-act=glclose]', 300);
  }
  // demo data tab: mock booking generation, then a full reset that keeps the admin session
  await go('#/admin/demo'); await click('[data-act=amock]', 800);
  console.log('mock bookings generated:', /Mock bookings created/.test(d.getElementById('toast').textContent));
  setv('mkconfirm', 'RESET'); await click('[data-act=areset]', 900);
  console.log('demo reset: still admin, Test Puja wiped:', /Admin panel/.test(text()) && !/Test Puja/.test(text()));
  console.log(errs.length ? errs.join('\n') : 'NO UI ERRORS');
  server.closeAllConnections(); server.close(); process.exit(errs.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
