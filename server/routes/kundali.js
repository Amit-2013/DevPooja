/* Kundali -> Dosh -> Recommendation flow.

   Endpoints:
     GET  /api/kundali/places?q=delhi       searchable birth-place index
     POST /api/kundali/generate             build the chart, run dosh analysis, recommend pujas
     GET  /api/kundali/:id                  fetch a saved kundali + its analysis (guest or owner)
     GET  /api/kundali/conditions            active conditions (public metadata for the UI)
     GET  /api/kundali/catalog               havan kunds + samagri items

   All astrology runs through server/services/astrology (real ephemeris, no fake data).
   /generate writes kundalis, dosh_analysis and puja_recommendations rows only; it never
   touches catalogue, bookings or payments. Added by migrations 003-005. */
'use strict';
const express = require('express');
const { db } = require('../db');
const { v, bad, HttpError, wrap, rid } = require('../lib/util');
const astro = require('../services/astrology');

const router = express.Router();
const ENGINE_VERSION = 'internal-ephemeris-v1';
const PURPOSES = ['General', 'Marriage', 'Career', 'Business', 'Health & Wellness', 'Finance', 'Education', 'Family', 'Child', 'Spiritual', 'Property', 'Other'];
const ACCURACIES = ['exact', 'approximate', 'unknown'];

/* Structured birth place for the API/UI. utcOffset is derived from the stored IANA
   zone at the birth instant (IST stays a fixed +05:30, matching the engine). */
function utcOffsetFor(tz, utc) {
  const z = String(tz || '');
  if (/Kolkata|Calcutta|Asia[/]India|IST/i.test(z)) return 'UTC+05:30';
  try {
    const at = utc || new Date();
    /* Format the instant in the target zone, then parse the wall clock back and
       compare against the instant itself to recover the offset in minutes. */
    const wall = new Date(at.toLocaleString('en-US', { timeZone: z || 'UTC' }));
    const offMin = Math.round((wall.getTime() - at.getTime()) / 60000);
    if (Number.isFinite(offMin)) {
      const sign = offMin >= 0 ? '+' : '-'; const a = Math.abs(offMin);
      return 'UTC' + sign + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
    }
  } catch (e) { /* fall through */ }
  return '';
}
const placeObject = (p, utc) => ({
  city: p.city || '', state: p.state || '', country: p.country || '',
  lat: p.lat, lon: p.lon, tz: p.tz || '', utcOffset: utcOffsetFor(p.tz, utc)
});

/* --- GET /places?q= ------------------------------------------------------- */
router.get('/places', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ places: [] });
  const rows = db.prepare(`
    SELECT id, city, state, country, lat, lon, tz FROM place_index
    WHERE city LIKE ? OR state LIKE ?
    ORDER BY population DESC, city LIMIT 8
  `).all('%' + q.replace(/[%_]/g, '') + '%', '%' + q.replace(/[%_]/g, '') + '%');
  res.json({ places: rows.map((r) => ({ id: r.id, label: [r.city, r.state, r.country].filter(Boolean).join(', '), city: r.city, state: r.state, country: r.country, lat: r.lat, lon: r.lon, tz: r.tz, utcOffset: utcOffsetFor(r.tz, null) })) });
}));

/* --- GET /conditions?lang= --------------------------------------------- */
router.get('/conditions', wrap(async (req, res) => {
  const hi = req.query.lang === 'hi';
  const rows = db.prepare('SELECT code, name, name_hi, descr, descr_hi, remedy, remedy_hi, severity FROM kundali_conditions WHERE active=1 ORDER BY severity DESC, name').all();
  res.json({ conditions: rows.map((r) => ({ code: r.code, name: r.name, nameHi: r.name_hi || '', descr: r.descr, descrHi: r.descr_hi || '', remedy: r.remedy, remedyHi: r.remedy_hi || '', severity: r.severity })) });
  void hi;
}));

/* --- GET /catalog --------------------------------------------------------- */
router.get('/catalog', wrap(async (_req, res) => {
  const kunds = db.prepare('SELECT id, name, material, size_in AS size, price, descr FROM havan_kunds WHERE active=1 ORDER BY price').all();
  const items = db.prepare('SELECT id, name, unit, category FROM samagri_items WHERE active=1 ORDER BY name').all();
  res.json({ kunds, samagriItems: items });
}));

/* --- POST /generate -------------------------------------------------------
   Body: { name, gender, dob, tob?, birthTimeAccuracy?, placeId? | {city,state,country,lat,lon,tz}, 
           email?, mobile?, gotra?, purpose?, save? }
   Returns the generated chart, the dosh analysis and the puja recommendations. */
router.post('/generate', wrap(async (req, res) => {
  const b = req.body || {};
  const name = v.str(b.name, 'Name', { max: 80 });
  const gender = b.gender ? v.oneOf(b.gender, ['male', 'female', 'other'], 'Gender') : '';
  const dob = v.date(b.dob, 'Date of birth');
  if (new Date(dob + 'T12:00:00') > new Date()) throw bad('Date of birth cannot be in the future');
  const tob = b.tob ? v.str(b.tob, 'Time of birth', { max: 8 }) : '';
  if (tob && !/^\d{1,2}:\d{2}$/.test(tob)) throw bad('Time of birth must be HH:MM (24-hour)');
  const accuracy = b.birthTimeAccuracy ? v.oneOf(b.birthTimeAccuracy, ACCURACIES, 'Birth time accuracy') : (tob ? 'exact' : 'unknown');

  /* place: either a saved place_index id or raw coordinates */
  let place;
  if (b.placeId) {
    const row = db.prepare('SELECT * FROM place_index WHERE id=?').get(v.int(b.placeId, 'Place'));
    if (!row) throw bad('Unknown birth place. Search again and pick a location from the list.');
    place = { city: row.city, state: row.state, country: row.country, lat: row.lat, lon: row.lon, tz: row.tz };
  } else if (b.place && typeof b.place === 'object' && Number.isFinite(+b.place.lat) && Number.isFinite(+b.place.lon)) {
    place = {
      city: v.str(b.place.city, 'City', { max: 80 }), state: v.str(b.place.state || '', 'State', { optional: true, max: 80 }),
      country: v.str(b.place.country || 'India', 'Country', { max: 80 }),
      lat: Math.max(-90, Math.min(90, +b.place.lat)), lon: Math.max(-180, Math.min(180, +b.place.lon)),
      tz: v.str(b.place.tz || 'Asia/Kolkata', 'Time zone', { max: 40 })
    };
  } else {
    throw bad('Choose a birth place from the list (search by city).');
  }

  const email = b.email ? v.email(b.email) : '';
  const mobile = b.mobile ? String(b.mobile).replace(/\D/g, '').slice(-10) : '';
  const gotra = b.gotra ? v.str(b.gotra, 'Gotra', { optional: true, max: 40 }) : '';
  const purpose = b.purpose ? v.oneOf(b.purpose, PURPOSES, 'Purpose') : 'General';

  /* 1. generate the kundali (real ephemeris) */
  let chart;
  try {
    chart = astro.kundali.buildChart({
      name, gender, dob, tob, birthTimeAccuracy: accuracy,
      lat: place.lat, lon: place.lon, tz: place.tz, place: [place.city, place.state, place.country].filter(Boolean).join(', '),
      city: place.city, state: place.state, country: place.country
    });
  } catch (e) {
    throw bad('Could not generate the kundali: ' + e.message);
  }

  /* 2. dosh analysis (rule engine over the chart) */
  const results = astro.dosh.analyze(chart);
  const detected = astro.dosh.detected(results);

  /* 3. puja / havan / samagri recommendations (DB-driven) */
  const recs = astro.recommend.recommendationsFor(detected, { purpose });
  const havans = astro.recommend.havanFor(recs.map((r) => r.pujaId));
  const samagri = astro.recommend.samagriFor(recs.map((r) => r.pujaId));

  /* 4. persist (guest-friendly; attached to the logged-in user when there is one) */
  const userId = req.auth && req.auth.uid ? req.auth.uid : null;
  const kundaliId = 'K' + rid(6);
  const dbtx = db.transaction(() => {
    let profileId = null;
    if (b.save) {
      profileId = 'kp' + rid(5);
      db.prepare(`INSERT INTO kundali_profiles(id,user_id,name,gender,dob,tob,pob,lat,lon,tz,state,country,birth_time_accuracy,purpose,email,mobile,gotra,whatsapp)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(profileId, userId, name, gender || null, dob, tob, place.city, place.lat, place.lon, place.tz, place.state || '', place.country || '', accuracy, purpose, email, mobile, gotra, b.whatsapp ? String(b.whatsapp).replace(/\D/g, '').slice(-10) : '');
    }
    db.prepare(`INSERT INTO kundalis(id,profile_id,name,chart_data,planetary_data,lagna,rashi,nakshatra,pada,dasha_data,navamsa_data,calculation_version)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(kundaliId, profileId, name, JSON.stringify(chart), JSON.stringify(astro.kundali.analysisView(chart)),
        chart.lagna.signName, chart.rashi.signName, chart.panchang.nakshatra, chart.planets.moon.nakshatra.pada,
        JSON.stringify(chart.dashas), JSON.stringify(chart.navamsaSigns), ENGINE_VERSION);

    const insDosh = db.prepare(`INSERT INTO dosh_analysis(kundali_id,dosh_type,detected,severity,confidence,explanation,evidence,evidence_hi,recommendation)
                                VALUES(?,?,?,?,?,?,?,?,?)`);
    for (const r of results) {
      const cond = db.prepare('SELECT remedy FROM kundali_conditions WHERE code=?').get(r.code);
      insDosh.run(kundaliId, r.code, r.detected ? 1 : 0, r.severity, r.confidence, r.explanation, JSON.stringify(r.evidence), JSON.stringify(r.evidenceHi || []), (cond && cond.remedy) || '');
    }
    const insRec = db.prepare(`INSERT INTO puja_recommendations(kundali_id,puja_id,recommendation_reason,priority,relevance_score,related_doshas,reason_hi)
                               VALUES(?,?,?,?,?,?,?)`);
    for (const r of recs) insRec.run(kundaliId, r.pujaId, r.reason, r.priority, r.weight, JSON.stringify(r.relatedDoshas), r.reasonHi || '');
    db.prepare('INSERT INTO kundali_activity(user_id,action,detail) VALUES(?,?,?)')
      .run(userId, 'kundali.generate', JSON.stringify({ kundaliId, detected: detected.length, recommendations: recs.length }));
    return profileId;
  });
  dbtx();

  /* 5. response: the full flow result for the result page */
  const order = { high: 0, medium: 1, low: 2, none: 3 };
  res.status(201).json({
    kundaliId,
    place: placeObject(place, new Date(chart.meta.utcIso)),
    chart,
    analysis: {
      engine: ENGINE_VERSION,
      doshas: [...results].sort((a, c) => (order[a.severity] ?? 9) - (order[c.severity] ?? 9)),
      detectedCount: detected.length
    },
    recommendations: recs,
    havans,
    samagri,
    disclaimer: 'This analysis follows traditional Jyotish rules on your birth details. It is offered for spiritual guidance and is not a prediction or guarantee of any future event.',
    disclaimerHi: 'यह विश्लेषण आपकी जन्म विवरणों पर पारंपरिक ज्योतिष नियमों के अनुसार है। यह आध्यात्मिक मार्गदर्शन हेतु है — यह किसी भी भविष्य की घटना की भविष्यवाणी या गारंटी नहीं है।'
  });
}));

/* --- GET /:id ------------------------------------------------------------- */
router.get('/:id', wrap(async (req, res) => {
  if (!/^K[a-f0-9]{12}$/.test(req.params.id)) throw new HttpError(404, 'Kundali not found');
  const k = db.prepare('SELECT * FROM kundalis WHERE id=?').get(req.params.id);
  if (!k) throw new HttpError(404, 'Kundali not found');
  const doshas = db.prepare('SELECT * FROM dosh_analysis WHERE kundali_id=?').all(k.id)
    .map((r) => ({ code: r.dosh_type, detected: !!r.detected, severity: r.severity, confidence: r.confidence, explanation: r.explanation, evidence: JSON.parse(r.evidence || '[]'), evidenceHi: JSON.parse(r.evidence_hi || '[]'), recommendation: r.recommendation }));
  const recs = db.prepare(`SELECT pr.*, p.name AS pujaName, p.icon FROM puja_recommendations pr LEFT JOIN pujas p ON p.id=pr.puja_id WHERE pr.kundali_id=? ORDER BY pr.priority, pr.relevance_score DESC`).all(k.id)
    .map((r) => ({ pujaId: r.puja_id, name: r.pujaName, icon: r.icon, priority: r.priority, reason: r.recommendation_reason, reasonHi: r.reason_hi || '', weight: r.relevance_score, relatedDoshas: JSON.parse(r.related_doshas || '[]') }));
  const chart = JSON.parse(k.chart_data || '{}');
  const prof = k.profile_id ? db.prepare('SELECT * FROM kundali_profiles WHERE id=?').get(k.profile_id) : null;
  const place = (chart.meta && chart.meta.lat != null) ? placeObject({ city: chart.meta.city || (prof && prof.pob) || '', state: chart.meta.state || (prof && prof.state) || '', country: chart.meta.country || (prof && prof.country) || '', lat: chart.meta.lat, lon: chart.meta.lon, tz: chart.meta.tz }, chart.meta.utcIso ? new Date(chart.meta.utcIso) : null)
    : (prof ? placeObject({ city: prof.pob, state: prof.state, country: prof.country, lat: prof.lat, lon: prof.lon, tz: prof.tz }, null) : null);
  res.json({
    kundaliId: k.id, name: k.name, lagna: k.lagna, rashi: k.rashi, nakshatra: k.nakshatra, pada: k.pada,
    place, chart, dashas: JSON.parse(k.dasha_data || '{}'), navamsa: JSON.parse(k.navamsa_data || '{}'),
    doshas, recommendations: recs, engine: k.calculation_version
  });
}));

module.exports = router;
