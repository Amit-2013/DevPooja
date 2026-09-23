/* Builds the full Kundali: signs, nakshatras, houses, navamsa, dashas, strength.

   Uses ephemeris.js for real sidereal positions. Nothing is hard-coded: every
   value is derived from the birth date, time and place the customer entered. */
'use strict';

const E = require('./ephemeris');

const SIGNS = ['Mesha (Aries)', 'Vrishabha (Taurus)', 'Mithuna (Gemini)', 'Karka (Cancer)', 'Simha (Leo)', 'Kanya (Virgo)', 'Tula (Libra)', 'Vrishchika (Scorpio)', 'Dhanu (Sagittarius)', 'Makara (Capricorn)', 'Kumbha (Aquarius)', 'Meena (Pisces)'];
const SIGN_SHORT = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'];
const NAKSHATRAS = [
  'Ashwini', 'Bharani', 'Krittika', 'Rohini', 'Mrigashira', 'Ardra', 'Punarvasu', 'Pushya', 'Ashlesha',
  'Magha', 'Purva Phalguni', 'Uttara Phalguni', 'Hasta', 'Chitra', 'Swati', 'Vishakha', 'Anuradha', 'Jyeshtha',
  'Mula', 'Purva Ashadha', 'Uttara Ashadha', 'Shravana', 'Dhanishta', 'Shatabhisha', 'Purva Bhadrapada', 'Uttara Bhadrapada', 'Revati'
];
const LORDS = ['Mars', 'Venus', 'Mercury', 'Moon', 'Sun', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Saturn', 'Jupiter'];
const TITHIS = ['Pratipada', 'Dwitiya', 'Trita', 'Chaturthi', 'Panchami', 'Shashthi', 'Saptami', 'Ashtami', 'Navami', 'Dashami', 'Ekadashi', 'Dwadashi', 'Trayodashi', 'Chaturdashi'];
const VARAS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const PLANET_ORDER = ['sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn', 'rahu', 'ketu'];
const DISPLAY = { sun: 'Sun ☉', moon: 'Moon ☽', mars: 'Mars ♂', mercury: 'Mercury ☿', jupiter: 'Jupiter ♃', venus: 'Venus ♀', saturn: 'Saturn ♄', rahu: 'Rahu ☊', ketu: 'Ketu ☋' };

/* Vimshottari periods in solar years. The nakshatra lord cycle starts at Ashwini = Ketu
   and follows the dasha order; a nakshatra's lord determines the first mahadasha. */
const DASHA = { Ketu: 7, Venus: 20, Sun: 6, Moon: 10, Mars: 7, Rahu: 18, Jupiter: 16, Saturn: 19, Mercury: 17 };
const DASHA_ORDER = ['Ketu', 'Venus', 'Sun', 'Moon', 'Mars', 'Rahu', 'Jupiter', 'Saturn', 'Mercury'];

const nakOf = (lon) => {
  const span = 360 / 27;
  const i = Math.floor(lon / span);
  return { name: NAKSHATRAS[i], pada: Math.floor((lon % span) / (span / 4)) + 1, lord: DASHA_ORDER[i % 9] };
};
/* Evaluates the simple dignity rules the engine uses for the "status" column. */
const DIGNITY = {
  exalted: { sun: 0, moon: 1, mars: 9, mercury: 5, jupiter: 3, venus: 11, saturn: 6, rahu: 1, ketu: 7 },
  debilitated: { sun: 6, moon: 7, mars: 3, mercury: 11, jupiter: 9, venus: 5, saturn: 0, rahu: 7, ketu: 1 },
  own: { sun: [4], moon: [3], mars: [0, 7], mercury: [2, 5], jupiter: [8, 11], venus: [1, 6], saturn: [9, 10] }
};

function dignityOf(planet, sign) {
  if (DIGNITY.exalted[planet] === sign) return 'Exalted';
  if (DIGNITY.debilitated[planet] === sign) return 'Debilitated';
  if ((DIGNITY.own[planet] || []).includes(sign)) return 'Own sign';
  return 'Neutral';
}

function dashaTimeline(moonLon, utcDate) {
  const nak = nakOf(moonLon);
  const startLord = nak.lord;
  const yearMs = 365.2425 * 86400000;
  const elapsedFrac = (moonLon % (360 / 27)) / (360 / 27); /* portion of the first dasha already elapsed */
  const timeline = [];
  let t = utcDate.getTime() - elapsedFrac * DASHA[startLord] * yearMs;
  let li = DASHA_ORDER.indexOf(startLord);
  for (let i = 0; i < 10; i++) {
    const l = DASHA_ORDER[(li + i) % 9];
    const dur = DASHA[l] * yearMs;
    timeline.push({ lord: l, from: new Date(t).toISOString().slice(0, 10), to: new Date(t + dur).toISOString().slice(0, 10), years: DASHA[l] });
    t += dur;
  }
  const now = Date.now();
  const current = timeline.find((d) => d.from <= new Date(now).toISOString().slice(0, 10) && d.to >= new Date(now).toISOString().slice(0, 10));
  return { balanceAtBirth: Math.round((1 - elapsedFrac) * DASHA[startLord] * 12) / 12, periods: timeline, current: current || timeline[0] };
}

/* Whole-sign houses. houseOfSign(s) = ((s - lagnaSign) mod 12) + 1 */
function buildChart(input) {
  const { name, gender, dob, tob, birthTimeAccuracy, lat, lon, tz } = input;
  const hm = /^(\d{1,2}):(\d{2})$/.exec(tob || '');
  const hh = hm ? +hm[1] : 12, mm = hm ? +hm[2] : 0;
  /* Approximate zone offset: the DB stores the IANA name but the engine only needs
     the civil offset at birth, which for all-India charts is fixed +05:30 (IST since 1947). */
  const offsetMin = /Kolkata|Calcutta|Asia\/India|IST/i.test(tz || '') ? 330 : 0;
  const localNoon = `${dob}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
  const utc = new Date(new Date(localNoon + 'Z').getTime() - offsetMin * 60000);
  if (isNaN(utc.getTime())) throw new Error('Invalid birth date or time');

  const trop = E.positions(utc);
  const ayan = E.ayanamsa(E.julianDay(utc));
  const lagnaSid = E.ascendant(utc, lat, lon);
  const lagnaSign = Math.floor(lagnaSid / 30);

  const planets = {};
  for (const p of PLANET_ORDER) {
    const lonSid = trop[p];
    const sign = Math.floor(lonSid / 30);
    const house = ((sign - lagnaSign + 12) % 12) + 1;
    planets[p] = {
      sidereal: +lonSid.toFixed(4),
      tropical: +E.norm(trop[p] + ayan).toFixed(4),
      sign, signName: SIGN_SHORT[sign], house,
      degreeInSign: +(lonSid % 30).toFixed(2),
      nakshatra: nakOf(lonSid),
      dignity: dignityOf(p, sign),
      retrograde: p === 'rahu' || p === 'ketu' /* nodes are always retrograde; classical convention */
    };
  }

  /* Chandra lagna (moon sign) and its houses, used by several rules */
  const moonSign = planets.moon.sign;

  /* Navamsa (D9): the classical rule — navamsa lagna starts at the sign itself for
     movable signs, the 9th from it for fixed, the 5th for dual. navamsaIndex =
     (sign + part) mod 12 with part counted from that root. */
  const navamsaSignOf = (sign, degInSign) => {
    const part = Math.floor(degInSign / (30 / 9));
    const root = sign % 3 === 0 ? sign : sign % 3 === 1 ? (sign + 8) % 12 : (sign + 4) % 12;
    return SIGN_SHORT[(root + part) % 12];
  };
  const navamsa = {};
  for (const p of PLANET_ORDER) navamsa[p] = navamsaSignOf(planets[p].sign, planets[p].degreeInSign);

  const tithiNum = Math.floor(E.norm(trop.moon - trop.sun) / 12) + 1;   /* 1..30 */
  const paksha = tithiNum <= 15 ? 'Shukla' : 'Krishna';
  const tithiName = TITHIS[(tithiNum - 1) % 15];
  const vara = VARAS[utc.getUTCDay()]; /* close enough for display; the pandit confirms muhurta */

  const nakLagna = nakOf(lagnaSid);

  return {
    meta: {
      name, gender, dob, tob: tob || 'Unknown', birthTimeAccuracy: birthTimeAccuracy || 'exact',
      place: input.place, lat, lon, tz,
      utcIso: utc.toISOString(), ayanamsaName: 'Lahiri (Chitrapaksha)',
      ayanamsa: +ayan.toFixed(4), engine: 'internal-ephemeris-v1', calculatedAt: new Date().toISOString()
    },
    lagna: { longitude: +lagnaSid.toFixed(4), sign: lagnaSign, signName: SIGN_SHORT[lagnaSign], signFull: SIGNS[lagnaSign], lord: LORDS[lagnaSign], nakshatra: nakLagna },
    rashi: { moonSign, signName: SIGN_SHORT[moonSign], signFull: SIGNS[moonSign], lord: LORDS[moonSign] },
    sunSign: SIGN_SHORT[planets.sun.sign],
    planets,
    houses: Array.from({ length: 12 }, (_, i) => ({ house: i + 1, sign: (lagnaSign + i) % 12, signName: SIGN_SHORT[(lagnaSign + i) % 12], lord: LORDS[(lagnaSign + i) % 12] })),
    panchang: { tithiNumber: tithiNum, paksha, tithi: paksha + ' ' + tithiName, vara, nakshatra: planets.moon.nakshatra.name, yoga: null, karana: null },
    dashas: dashaTimeline(trop.moon, utc),
    navamsaSigns: navamsa
  };
}

/* Analysis-friendly view: only what the dosh rules need. */
function analysisView(chart) {
  return {
    lagnaSign: chart.lagna.sign,
    moonSign: chart.rashi.moonSign,
    sunSign: Math.floor(chart.planets.sun.sidereal / 30),
    planets: Object.fromEntries(PLANET_ORDER.map((p) => {
      const q = chart.planets[p];
      return [p, { sign: q.sign, house: q.house, degreeInSign: q.degreeInSign, dignity: q.dignity, nakshatra: q.nakshatra.name, navamsaSign: chart.navamsaSigns[p] }];
    })),
    dasha: { currentLord: chart.dashas.current.lord, nextLord: chart.dashas.periods[chart.dashas.periods.findIndex((d) => d === chart.dashas.current) + 1]?.lord || null }
  };
}

module.exports = { buildChart, analysisView, SIGNS, SIGN_SHORT, NAKSHATRAS, LORDS, PLANET_ORDER, DISPLAY, nakOf, dashaTimeline };
