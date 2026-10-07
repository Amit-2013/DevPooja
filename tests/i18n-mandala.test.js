/* Frontend gates for two section-13 acceptance items no other suite covered:
   LANGUAGE SWITCHING (the header English | हिंदी control) and the MANDALA hero art.

   Scope note: the project ships a mandala and no yantra — a repo-wide search for
   "yantra" (js/py/html/css/md) returns zero hits — so the art gate asserts the
   mandala that actually exists instead of inventing coverage for a feature that
   was never built.

   Approach: boot the REAL server, load the REAL SPA in jsdom (same harness as
   tests/ui-smoke.js) and assert through the DOM and CSSOM — that the art renders
   as an accessible inline SVG, that the stylesheet (attached to the document,
   not merely present on disk) drives its spin and disables it under
   prefers-reduced-motion, and that the language control flips the persisted
   preference, re-renders nav + H1 into the other script, then restores the
   original English bytes.

   Run: node --test tests/i18n-mandala.test.js   (wired into `npm test` -> CI) */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'i18n-mandala-test';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpi18n-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.UPLOAD_DIR = path.join(tmp, 'up');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, ResourceLoader } = require('jsdom');
const app = require('../server/index.js');
const seedMod = require('../server/seed');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
/* Only fetch same-origin resources: fonts.googleapis.com and the Razorpay
   checkout script are referenced by index.html and would otherwise stall (or
   fail) in CI, exactly as ui-smoke treats them. */
class Loader extends ResourceLoader {
  fetch(url, o) { return url.startsWith('http://127.0.0.1') ? super.fetch(url, o) : Promise.resolve(Buffer.from('')); }
}

let server, base, dom, w, d, englishH1;

test.before(async () => {
  /* Await the boot media pipeline before serving, same reason as api.test.js:
     seeding photos + WebP variants must not race the first page render. */
  await seedMod.settledMedia();
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = 'http://127.0.0.1:' + server.address().port + '/';
  dom = await JSDOM.fromURL(base, {
    runScripts: 'dangerously', resources: new Loader(), pretendToBeVisual: true,
    beforeParse(win) {
      win.scrollTo = () => {};
      win.matchMedia = () => ({ matches: false });
      win.FormData = FormData;
      win.Blob = Blob;
      win.fetch = (u, o) => fetch(new URL(u, base), o);
      win.addEventListener('error', (e) => errs.push('ERR ' + e.message));
    },
  });
  w = dom.window;
  d = w.document;
  for (let i = 0; i < 50 && !d.querySelector('#view h1'); i++) await sleep(100);
  assert.ok(d.querySelector('#view h1'), 'SPA home rendered an H1');
});

test.after(() => {
  try { if (dom) dom.window.close(); } catch (e) { /* already gone */ }
  if (server) { server.closeAllConnections(); server.close(); }
});

test('mandala: renders as an accessible inline SVG with rings and petals', () => {
  const m = d.querySelector('.mandala');
  assert.ok(m, 'a .mandala element is rendered on the home hero');
  assert.equal(m.tagName.toLowerCase(), 'svg', 'it is inline SVG, not an <img>');
  assert.ok(m.closest('.hero'), 'it sits inside the hero section');
  assert.ok(m.querySelectorAll('circle').length >= 5, 'concentric rings drawn');
  assert.ok(m.querySelectorAll('ellipse').length >= 16, 'petal ellipses drawn');
  assert.equal(m.getAttribute('aria-hidden'), 'true',
    'decorative art must be hidden from assistive tech');
});

test('mandala: the attached stylesheet drives the spin and honours reduced motion', () => {
  /* CSSOM first: proves a rule is actually attached to this document and
     applied to the element, not merely present in a file nobody links. */
  let spinRule = null, reducedRule = null;
  for (const sheet of d.styleSheets) {
    try {
      for (const r of sheet.cssRules) {
        const txt = r.cssText || '';
        if (r.selectorText && /\.mandala\b/.test(r.selectorText) && /animation/.test(txt)) spinRule = txt;
        if (/prefers-reduced-motion/.test(txt) && /\.mandala\b/.test(txt)) reducedRule = txt;
      }
    } catch (e) { /* a cross-origin sheet has no readable cssRules — skip it */ }
  }
  assert.ok(spinRule, 'a .mandala rule carrying an animation is attached to the document');
  assert.match(spinRule, /spin/, 'the animation is the spin keyframes');
  assert.ok(reducedRule, 'a prefers-reduced-motion rule mentions .mandala');
  assert.match(reducedRule, /animation:\s*none/, 'reduced motion must stop the spin');

  /* Source of truth too: a CSS refactor that drops either half must fail here. */
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  assert.match(css, /\.mandala\{[^}]*animation:spin 240s linear infinite\}/,
    'app.css must keep the slow rotation on .mandala');
  assert.match(css, /prefers-reduced-motion:reduce\)\{[^}]*\.mandala\{animation:none\}/,
    'app.css must keep the .mandala reduced-motion opt-out');
});

test('language: header offers both languages and the site starts in English', () => {
  const hdr = d.getElementById('hdr');
  assert.ok(hdr, 'header rendered');
  const en = hdr.querySelector('[data-act=setlang][data-v=en]');
  const hi = hdr.querySelector('[data-act=setlang][data-v=hi]');
  assert.ok(en && hi, 'both language buttons are present in the utility bar');
  assert.equal(en.getAttribute('aria-pressed'), 'true', 'English starts active');
  assert.equal(hi.getAttribute('aria-pressed'), 'false');
  assert.equal(w.eval("store.get('dp_lang','en')"), 'en', 'no saved preference yet');
  assert.match(hdr.textContent, /About us/, 'English nav label rendered');
  assert.ok(!/हमारे लोग/.test(hdr.textContent), 'no Hindi nav label before switching');
  englishH1 = d.querySelector('#view h1').textContent;
  assert.ok(!/[\u0900-\u097F]/.test(englishH1), 'H1 is Latin while in English');
});

test('language: switching to हिंदी persists, flips aria state and re-renders', async () => {
  const hi = d.querySelector('[data-act=setlang][data-v=hi]');
  assert.ok(hi, 'hindi button reachable');
  hi.click();
  await sleep(500);
  assert.equal(w.eval("store.get('dp_lang','en')"), 'hi', 'preference persisted for next visit');
  const hdr = d.getElementById('hdr');
  assert.match(hdr.textContent, /हमारे लोग/, 'nav label translated');
  assert.ok(!/About us/.test(hdr.textContent), 'English nav label is gone');
  assert.equal(hdr.querySelector('[data-act=setlang][data-v=hi]').getAttribute('aria-pressed'),
    'true', 'aria-pressed follows the active language');
  const h1 = d.querySelector('#view h1').textContent;
  assert.match(h1, /[\u0900-\u097F]/, 'page content re-rendered in Devanagari');
  assert.notEqual(h1, englishH1, 'the Hindi H1 differs from the English one');
});

test('language: switching back restores the original English exactly', async () => {
  const en = d.querySelector('[data-act=setlang][data-v=en]');
  assert.ok(en, 'english button reachable after switching');
  en.click();
  await sleep(500);
  assert.equal(w.eval("store.get('dp_lang','en')"), 'en', 'preference restored');
  const hdr = d.getElementById('hdr');
  assert.match(hdr.textContent, /About us/, 'nav label back to English');
  assert.ok(!/हमारे लोग/.test(hdr.textContent), 'Hindi nav label gone again');
  assert.equal(hdr.querySelector('[data-act=setlang][data-v=en]').getAttribute('aria-pressed'),
    'true', 'aria-pressed follows back to English');
  assert.equal(d.querySelector('#view h1').textContent, englishH1,
    'H1 restored byte-for-byte to the original English text');
});

test('the language + mandala round trip produced no uncaught page errors', () => {
  assert.deepEqual(errs, [], 'jsdom reported script errors during the round trip');
});
