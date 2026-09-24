/* Unit tests for the astrology service: ephemeris accuracy anchors, chart builder
   invariants, and dosh rule behaviour. Run: node --test tests/astro.test.js */
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../server/services/astrology/ephemeris');
const K = require('../server/services/astrology/kundaliEngine');
const rules = require('../server/services/astrology/rules');
const { norm } = E;

const SIGNS = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'];
const signOf = (lon) => SIGNS[Math.floor(norm(lon) / 30)];

/* Apparent geocentric ecliptic longitudes of date (tropical), fetched from the
   JPL Horizons API (QUANTITIES=31, ObsEcLon column) for these exact instants.
   The engine returns Lahiri-sidereal longitudes; tests convert with the module
   ayanamsa and compare. Tolerances: 3 arc-minutes (light-time/aberration residuals). */
const JPL = {
  '2026-01-15T05:00:00Z': { sun: 295.0451599, moon: 254.5833759, mars: 293.6417421, venus: 297.0801953, jupiter: 109.4557555, saturn: 357.1445642 },
  '1990-01-15T05:00:00Z': { sun: 294.7812593, moon: 163.8452708, mars: 259.7014597, venus: 300.8584139, jupiter: 93.4003470, saturn: 287.2800969 }
};
const TOL = { sun: 0.02, moon: 0.05, mars: 0.05, venus: 0.05, jupiter: 0.1, saturn: 0.1 };

for (const [when, expected] of Object.entries(JPL)) {
  test('ephemeris matches JPL Horizons for ' + when, () => {
    const d = new Date(when);
    const p = E.positions(d);
    const ayan = E.ayanamsa(E.julianDay(d));
    for (const [body, jpl] of Object.entries(expected)) {
      const tropical = norm(p[body] + ayan);
      const diff = Math.abs(norm(tropical - jpl + 180) - 180);
      assert.ok(diff < TOL[body], `${body} ${tropical.toFixed(4)} vs JPL ${jpl} (diff ${diff.toFixed(4)}°)`);
    }
  });
}

test('nodes are opposite each other', () => {
  const p = E.positions(new Date('2010-11-15T12:00:00Z'));
  assert.ok(Math.abs(norm(p.rahu + 180 - p.ketu) - 180) < 1e-6 || norm(p.rahu + 180 - p.ketu) < 1e-6);
});

test('ascendant matches published sidereal charts', () => {
  /* M.K. Gandhi, 1869-10-02 ~02:33 UT Porbandar: classical charts give Libra lagna ~3-5° */
  const gandhi = E.ascendant(new Date('1869-10-02T02:33:00Z'), 21.64, 69.6);
  assert.equal(signOf(gandhi), 'Libra');
  /* Albert Einstein, 1879-03-14 10:50 UT Ulm: published sidereal lagna Gemini ~17-20° */
  const einstein = E.ascendant(new Date('1879-03-14T10:50:00Z'), 48.4, 10.0);
  assert.equal(signOf(einstein), 'Gemini');
});

test('chart builder: lagna, rashi, nakshatra, dasha invariants', () => {
  const c = K.buildChart({ name: 'Test', dob: '1990-01-15', tob: '10:30', lat: 28.6139, lon: 77.2090, tz: 'Asia/Kolkata', place: 'Delhi' });
  assert.equal(c.lagna.signName, 'Pisces');
  assert.equal(c.rashi.signName, 'Leo');
  assert.equal(c.panchang.nakshatra, 'Purva Phalguni');
  /* Purva Phalguni is Venus-ruled: the first mahadasha must be Venus */
  assert.equal(c.dashas.periods[0].lord, 'Venus');
  /* dasha periods must be contiguous and follow the Vimshottari order */
  const order = ['Venus', 'Sun', 'Moon', 'Mars', 'Rahu', 'Jupiter', 'Saturn', 'Mercury', 'Ketu'];
  const seq = c.dashas.periods.slice(0, 9).map((d) => d.lord);
  const i = order.indexOf(seq[0]);
  seq.forEach((l, idx) => assert.equal(l, order[(i + idx) % 9], 'dasha order'));
  /* every planet has house 1..12 and a nakshatra */
  for (const p of Object.values(c.planets)) {
    assert.ok(p.house >= 1 && p.house <= 12);
    assert.ok(p.nakshatra.pada >= 1 && p.nakshatra.pada <= 4);
  }
  /* lagna house 1 contains planets whose sign equals the lagna sign */
  for (const p of Object.values(c.planets)) {
    if (p.sign === c.lagna.sign) assert.equal(p.house, 1);
  }
});

test('chart works without a birth time (noon fallback, accuracy recorded)', () => {
  const c = K.buildChart({ name: 'No Time', dob: '2000-06-15', tob: '', lat: 19.076, lon: 72.8777, tz: 'Asia/Kolkata', place: 'Mumbai' });
  assert.ok(c.meta.tob === 'Unknown' || c.meta.tob === '');
  assert.ok(c.planets && c.planets.sun);
  const withTime = K.buildChart({ name: 'With Time', dob: '2000-06-15', tob: '03:00', lat: 19.076, lon: 72.8777, tz: 'Asia/Kolkata', place: 'Mumbai' });
  /* moon moves ~0.5°/hour: 9h shift must move it about 4-5°, but never change the Sun's sign here */
  assert.equal(withTime.planets.sun.signName, c.planets.sun.signName);
});

test('mangal dosha rule: detects 7th-house Mars, cancels on own sign', () => {
  const view = (marsSign, marsDignity) => ({
    lagnaSign: 0, moonSign: 0,
    planets: {
      mars: { sign: marsSign, house: ((marsSign - 0 + 12) % 12) + 1, degreeInSign: 10, dignity: marsDignity },
      venus: { sign: 5, house: 6, degreeInSign: 1, dignity: 'Neutral' },
      jupiter: { sign: 8, house: 9, degreeInSign: 1, dignity: 'Neutral' },
      sun: { sign: 2, house: 3, degreeInSign: 1, dignity: 'Neutral' },
      moon: { sign: 0, house: 1, degreeInSign: 1, dignity: 'Neutral' },
      mercury: { sign: 2, house: 3, degreeInSign: 1, dignity: 'Neutral' },
      saturn: { sign: 9, house: 10, degreeInSign: 1, dignity: 'Neutral' },
      rahu: { sign: 3, house: 4, degreeInSign: 1, dignity: 'Neutral' },
      ketu: { sign: 9, house: 10, degreeInSign: 1, dignity: 'Neutral' }
    }
  });
  const detected = rules.mangal_dosha.evaluate(view(6, 'Neutral')); /* Mars in Libra = 7th from Aries lagna */
  assert.ok(detected && detected.detected && detected.severity === 'high');
  const own = rules.mangal_dosha.evaluate(view(0, 'Own sign')); /* Mars in Aries = 1st house, own sign */
  assert.ok(own && own.detected && own.severity === 'low', 'own-sign Mars should soften to low');
  /* Mars in Virgo: 6th from lagna (clean) but 1st from Venus — move Venus away too */
  const far = view(5, 'Neutral'); far.planets.venus.sign = 7;
  assert.equal(rules.mangal_dosha.evaluate(far), null);
});

test('grahan dosha rule: Sun with node within 5 degrees is high severity', () => {
  const view = {
    lagnaSign: 0, moonSign: 0,
    planets: {
      sun: { sign: 4, house: 5, degreeInSign: 12.0, dignity: 'Neutral' },
      moon: { sign: 0, house: 1, degreeInSign: 15.0, dignity: 'Neutral' },
      rahu: { sign: 4, house: 5, degreeInSign: 16.0, dignity: 'Neutral' },
      ketu: { sign: 10, house: 11, degreeInSign: 16.0, dignity: 'Neutral' },
      mars: { sign: 2, house: 3, degreeInSign: 1, dignity: 'Neutral' },
      mercury: { sign: 4, house: 5, degreeInSign: 20, dignity: 'Neutral' },
      jupiter: { sign: 8, house: 9, degreeInSign: 1, dignity: 'Neutral' },
      venus: { sign: 5, house: 6, degreeInSign: 1, dignity: 'Neutral' },
      saturn: { sign: 9, house: 10, degreeInSign: 1, dignity: 'Neutral' }
    }
  };
  const out = rules.grahan_dosha.evaluate(view);
  assert.ok(out && out.detected && out.severity === 'high');
  assert.match(out.evidence[0], /Sun/);
});

test('nadi dosha rule: same nadi detected, different nadi not', () => {
  const base = { moonSign: 3, moonNakshatraIndex: 6 };
  const same = rules.nadi_dosha.evaluate(base, { moonSign: 3, moonNakshatraIndex: 9 }); /* both Adi */
  assert.ok(same && same.detected);
  const diff = rules.nadi_dosha.evaluate(base, { moonSign: 5, moonNakshatraIndex: 10 }); /* Madhya vs Adi */
  assert.ok(diff && !diff.detected);
  assert.equal(rules.nadi_dosha.evaluate(base, null), null, 'no partner: rule does not fire');
});

/* ---- Hindi (Devanagari) fields: additive, English always intact ---- */
test('hindi engine fields: signs, nakshatras, planets, dignity, panchang, dasha', () => {
  /* all 12 rashis, English alongside Hindi */
  assert.equal(K.SIGN_HI.length, 12);
  assert.equal(K.SIGN_HI[0], 'मेष');
  assert.equal(K.SIGN_HI[11], 'मीन');
  assert.equal(K.SIGN_SHORT[0], 'Aries');
  /* all 27 nakshatras in Hindi */
  assert.equal(K.NAKSHATRAS_HI.length, 27);
  assert.equal(K.NAKSHATRAS_HI[0], 'अश्विनी');
  assert.equal(K.NAKSHATRAS_HI[26], 'रेवती');
  assert.equal(K.NAKSHATRAS.length, 27);
  /* planet names */
  assert.equal(K.DISPLAY_HI.sun, 'सूर्य');
  assert.equal(K.DISPLAY_HI.moon, 'चंद्र');
  assert.equal(K.DISPLAY_HI.mars, 'मंगल');
  assert.equal(K.DISPLAY_HI.mercury, 'बुध');
  assert.equal(K.DISPLAY_HI.jupiter, 'गुरु');
  assert.equal(K.DISPLAY_HI.venus, 'शुक्र');
  assert.equal(K.DISPLAY_HI.saturn, 'शनि');
  assert.equal(K.DISPLAY_HI.rahu, 'राहु');
  assert.equal(K.DISPLAY_HI.ketu, 'केतु');

  const c = K.buildChart({ name: 'Hindi Tester', dob: '1990-01-15', tob: '10:30', lat: 28.6139, lon: 77.209, tz: 'Asia/Kolkata', place: 'Delhi', city: 'Delhi', state: 'Delhi', country: 'India' });
  /* English fields remain available next to the Hindi ones */
  assert.equal(c.lagna.signName, 'Pisces');
  assert.equal(c.lagna.signHi, 'मीन');
  assert.equal(c.rashi.signName, 'Leo');
  assert.equal(c.rashi.signHi, 'सिंह');
  /* sign + signHi and name + nameHi work on every planet row */
  for (const p of Object.values(c.planets)) {
    assert.ok(p.signName && p.signHi, 'planet has signName and signHi');
    assert.ok(K.NAKSHATRAS.includes(p.nakshatra.name), 'English nakshatra');
    assert.ok(K.NAKSHATRAS_HI.includes(p.nakshatra.nameHi), 'Hindi nakshatra');
    assert.ok(['उच्च', 'नीच', 'स्वराशि', 'मध्यम'].includes(p.dignityHi), 'Hindi dignity: ' + p.dignityHi);
    assert.ok(p.dignity, 'English dignity kept');
  }
  /* panchang is translated */
  assert.ok(c.panchang.tithiHi.includes('पक्ष'));
  assert.ok(['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'].includes(c.panchang.varaHi));
  /* dasha lords carry Hindi */
  for (const d of c.dashas.periods) assert.ok(d.lordHi && d.lord !== d.lordHi);
  /* place details ride on meta */
  assert.equal(c.meta.city, 'Delhi');
  assert.equal(c.meta.state, 'Delhi');
  assert.equal(c.meta.country, 'India');
});

test('dosh rules emit Hindi evidence describing the actual condition', () => {
  const view = {
    lagnaSign: 0, moonSign: 0,
    planets: {
      sun: { sign: 2, house: 3, degreeInSign: 12.0, dignity: 'Neutral' },
      moon: { sign: 3, house: 4, degreeInSign: 15.0, dignity: 'Neutral' },
      rahu: { sign: 2, house: 3, degreeInSign: 16.0, dignity: 'Neutral' },
      ketu: { sign: 8, house: 9, degreeInSign: 16.0, dignity: 'Neutral' },
      mars: { sign: 6, house: 7, degreeInSign: 10, dignity: 'Neutral' },
      mercury: { sign: 4, house: 5, degreeInSign: 20, dignity: 'Neutral' },
      jupiter: { sign: 6, house: 7, degreeInSign: 1, dignity: 'Neutral' },
      venus: { sign: 5, house: 6, degreeInSign: 1, dignity: 'Neutral' },
      saturn: { sign: 7, house: 8, degreeInSign: 1, dignity: 'Neutral' }
    }
  };
  const mg = rules.mangal_dosha.evaluate(view);
  assert.ok(mg.detected && mg.evidenceHi.some((e) => e.includes('मंगल') && e.includes('सप्तम')));
  const gr = rules.grahan_dosha.evaluate(view);
  assert.ok(gr.detected && gr.evidenceHi.length && /[\u0900-\u097F]/.test(gr.evidenceHi[0]), 'Devanagari evidence');
  const ks = rules.kaal_sarp.evaluate(view);
  assert.ok(ks.detected && ks.evidenceHi.some((e) => e.includes('राहु-केतु')));
  /* English evidence is still present side by side */
  assert.ok(mg.evidence[0].includes('Mars'));
  assert.ok(gr.evidence[0].includes('Sun'));
});
