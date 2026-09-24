/* Kundali -> Dosh -> Recommendation flow, with the commercial model.

   Endpoints:
     GET  /api/kundali/places?q=delhi       searchable birth-place index
     GET  /api/kundali/pricing              current pricing + the user's quota (auth-aware)
     POST /api/kundali/quote                quote for a family/additional kundali (customer)
     POST /api/kundali/generate             build the chart, run dosh analysis, recommend pujas
     POST /api/kundali/pay/verify           verify payment for a PENDING_PAYMENT kundali
     GET  /api/kundali/mine                 the customer's kundalis + quota (customer)
     GET  /api/kundali/:id                  fetch a saved kundali + its analysis (owner/admin/pandit or guest link)

   All astrology runs through server/services/astrology (real ephemeris, no fake data).
   /generate writes kundalis, dosh_analysis and puja_recommendations rows only; it never
   touches the puja catalogue or bookings. Added by migrations 003-005, 008. */
'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, tx } = require('../db');
const { v, bad, HttpError, wrap, rid } = require('../lib/util');
const astro = require('../services/astrology');
const KB = require('../services/kundaliBilling');
const pay = require('../services/payments');

const router = express.Router();
const ENGINE_VERSION = 'internal-ephemeris-v1';
const PURPOSES = ['General', 'Marriage', 'Career', 'Business', 'Health & Wellness', 'Finance', 'Education', 'Family', 'Child', 'Spiritual', 'Property', 'Other'];
const ACCURACIES = ['exact', 'approximate', 'unknown'];
const RELATIONSHIPS = ['Father', 'Mother', 'Spouse', 'Son', 'Daughter', 'Brother', 'Sister', 'Grandfather', 'Grandmother', 'Other'];

/* Expensive endpoint: hard limit BEFORE the ephemeris runs (15 / 15 min / IP+user). */
const genLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many Kundali generation requests. Please try again later.' },
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req) => (req.auth && req.auth.uid ? 'u:' + req.auth.uid : 'ip:' + req.ip)
});
router.use('/generate', genLimiter);
router.use('/quote', genLimiter);

/* Structured birth place for the API/UI. utcOffset is derived from the stored IANA
   zone at the birth instant (IST stays a fixed +05:30, matching the engine). */
function utcOffsetFor(tz, utc) {
  const z = String(tz || '');
  if (/Kolkata|Calcutta|Asia[/]India|IST/i.test(z)) return 'UTC+05:30';
  try {
    const at = utc || new Date();
    const wall = new Date(at.toLocaleString('en-US', { timeZone: z || 'UTC' }));
    const offMin = Math.round((wall.getTime() - at.getTime()) / 60000);
    if (Number.isFinite(offMin)) {
      const sign = offMin >= 0 ? '+' : '-';
      const a = Math.abs(offMin);
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

/* --- GET /conditions + /catalog: public metadata for the kundali UI -------- */
router.get('/conditions', (req, res) => {
  const rows = db.prepare('SELECT code, name, name_hi, descr, descr_hi, remedy, remedy_hi, severity FROM kundali_conditions WHERE active=1 ORDER BY severity DESC, name').all();
  res.json({ conditions: rows.map((r) => ({ code: r.code, name: r.name, nameHi: r.name_hi, descr: r.descr, descrHi: r.descr_hi, remedy: r.remedy, remedyHi: r.remedy_hi, severity: r.severity })) });
});
router.get('/catalog', (req, res) => {
  const kunds = db.prepare('SELECT id, name, material, size_in AS size, price, descr FROM havan_kunds WHERE active=1 ORDER BY price').all();
  const items = db.prepare('SELECT id, name, unit, category FROM samagri_items WHERE active=1 ORDER BY name').all();
  res.json({ kunds, items });
});

/* --- GET /pricing ---------------------------------------------------------- */
router.get('/pricing', (req, res) => {
  const p = KB.pricing();
  const u = req.auth && req.auth.role === 'customer' ? db.prepare('SELECT * FROM users WHERE id=?').get(req.auth.uid) : null;
  res.json({
    active: p.active, currency: p.currency, gstPct: p.gstPct, discountPct: p.discountPct,
    couponEligible: p.couponEligible,
    prices: { personal: p.personalPrice, family: p.familyPrice, additional: p.additionalPrice },
    freeCounts: p.freeCounts,
    quota: u ? { included: KB.includedCount(u), used: KB.usedCount(u.id), remaining: Math.max(0, KB.includedCount(u) - KB.usedCount(u.id)) } : null
  });
});

/* --- POST /quote (customer) ------------------------------------------------ */
router.post('/quote', (req, res) => {
  if (!req.auth || req.auth.role !== 'customer') throw new HttpError(401, 'Please log in');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.auth.uid);
  const q = KB.quoteFor(u, { relationship: req.body.relationship, coupon: req.body.coupon });
  res.json({ quote: q });
});

/* --- POST /pay/verify (customer): flip PENDING_PAYMENT -> PAID ------------- */
router.post('/pay/verify', (req, res) => {
  if (!req.auth || req.auth.role !== 'customer') throw new HttpError(401, 'Please log in');
  const id = String(req.body.kundaliId || '');
  const k = db.prepare('SELECT * FROM kundalis WHERE id=?').get(id);
  if (!k || k.customer_id !== req.auth.uid) throw new HttpError(404, 'Kundali not found');
  if (k.billing === 'PAID' || k.billing === 'FREE') return res.json({ ok: true, billing: k.billing });
  if (k.billing !== 'PENDING_PAYMENT') throw bad('This kundali is not awaiting payment');
  const sig = req.body.razorpay_signature ? req.body
    : { razorpay_order_id: req.body.razorpay_order_id, razorpay_payment_id: req.body.razorpay_payment_id, razorpay_signature: req.body.razorpay_signature };
  if (pay.mode() === 'razorpay') {
    if (k.order_id !== sig.razorpay_order_id || !pay.verifySignature(sig.razorpay_order_id, sig.razorpay_payment_id, sig.razorpay_signature)) {
      throw bad('Payment verification failed');
    }
  }
  const info = { ok: true, kundaliId: id, billing: 'PAID' };
  tx(() => {
    db.prepare("UPDATE kundalis SET billing='PAID', payment_status='Paid', payment_id=? WHERE id=?")
      .run(pay.mode() === 'razorpay' ? String(sig.razorpay_payment_id).slice(0, 60) : 'MOCK' + rid(4), id);
    KB.idemPut(req.body.idemKey, 'kundali.pay', info);
  })();
  res.json(info);
});

/* --- POST /generate --------------------------------------------------------
   Body: { name, gender, dob, tob?, birthTimeAccuracy?, placeId? | {city,state,country,lat,lon,tz},
           email?, mobile?, gotra?, purpose?, save?, relationship?|familyMemberId?, idemKey?, coupon? }
   Billing: personal kundalis within the plan quota are FREE; family/additional are
   PENDING_PAYMENT until /pay/verify (mock mode completes instantly). */
router.post('/generate', wrap(async (req, res) => {
  const b = req.body || {};
  /* Commercial classification happens first: a family-member request takes its
     details from the family_members row, so personal fields become optional. */
  const user = req.auth && req.auth.role === 'customer' ? db.prepare('SELECT * FROM users WHERE id=?').get(req.auth.uid) : null;
  let familyMemberId = null, relationship = '';
  if (b.familyMemberId) {
    if (!user) throw new HttpError(401, 'Please log in to create a family member kundali');
    const fm = db.prepare('SELECT * FROM family_members WHERE id=? AND customer_id=?').get(String(b.familyMemberId), user.id);
    if (!fm) throw bad('Family member not found');
    familyMemberId = fm.id; relationship = fm.relationship;
    if (fm.name) b.name = fm.name;
    if (fm.gender) b.gender = fm.gender;
    if (fm.dob) b.dob = fm.dob;
    if (fm.tob) b.tob = fm.tob;
    if (b.save === undefined) b.save = true;
  } else if (b.relationship) {
    if (!user) throw new HttpError(401, 'Please log in to create a family member kundali');
    relationship = v.oneOf(b.relationship, RELATIONSHIPS, 'Relationship');
  }
  const name = v.str(b.name, 'Name', { max: 80 });
  const gender = b.gender ? v.oneOf(b.gender, ['male', 'female', 'other'], 'Gender') : '';
  const dob = v.date(b.dob, 'Date of birth');
  if (new Date(dob + 'T12:00:00') > new Date()) throw bad('Date of birth cannot be in the future');
  let tob = b.tob ? v.str(b.tob, 'Time of birth', { max: 8 }) : '';
  if (tob && !/^\d{1,2}:\d{2}$/.test(tob)) throw bad('Time of birth must be HH:MM (24-hour)');
  const accuracy = b.birthTimeAccuracy ? v.oneOf(b.birthTimeAccuracy, ACCURACIES, 'Birth time accuracy') : (tob ? 'exact' : 'unknown');

  /* Idempotency: a repeated request (same key) returns the original result. */
  const idemKey = b.idemKey ? String(b.idemKey).slice(0, 120) : '';
  const prior = KB.idemGet(idemKey, 'kundali.generate');
  if (prior) return res.status(200).json(prior);

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

  /* A family member's saved place wins over the request's placeId. */
  if (familyMemberId) {
    const fm2 = db.prepare('SELECT * FROM family_members WHERE id=?').get(familyMemberId);
    if (fm2 && fm2.lat != null) place = { city: fm2.city || place.city, state: fm2.state || place.state, country: fm2.country || place.country, lat: fm2.lat, lon: fm2.lon, tz: fm2.tz || place.tz };
  }

  const bill = user ? KB.classify(user, relationship) : { family: !!relationship, included: false, base: 0, label: 'Guest' };
  const quote = user && bill.base > 0 ? KB.quoteFor(user, { relationship, coupon: b.coupon }) : null;
  const base = quote ? quote.base : bill.base;
  /* Paid kundalis are generated only in mock mode (instant paid) or held for payment. */
  const chargeable = !!user && base > 0;
  const gateway = pay.mode() === 'razorpay';
  const billing = chargeable ? (gateway ? 'PENDING_PAYMENT' : 'PAID') : 'FREE';

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
  const userId = user ? user.id : null;
  const kundaliId = 'K' + rid(6);
  const orderId = chargeable ? 'KDO' + rid(5) : '';
  const dbtx = db.transaction(() => {
    let profileId = null;
    if (b.save) {
      profileId = 'kp' + rid(5);
      db.prepare(`INSERT INTO kundali_profiles(id,user_id,name,gender,dob,tob,pob,lat,lon,tz,state,country,birth_time_accuracy,purpose,email,mobile,gotra,whatsapp)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(profileId, userId, name, gender || null, dob, tob, place.city, place.lat, place.lon, place.tz, place.state || '', place.country || '', accuracy, purpose, email, mobile, gotra, b.whatsapp ? String(b.whatsapp).replace(/\D/g, '').slice(-10) : '');
    }
    const qd = quote || { base, discount: 0, gst: 0, final: 0, currency: 'INR' };
    db.prepare(`INSERT INTO kundalis(id,profile_id,name,chart_data,planetary_data,lagna,rashi,nakshatra,pada,dasha_data,navamsa_data,calculation_version,
                customer_id,family_member_id,relationship,billing,price,discount,gst,final_amount,currency,order_id,payment_status,payment_id,idem_key)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(kundaliId, profileId, name, JSON.stringify(chart), JSON.stringify(astro.kundali.analysisView(chart)),
        chart.lagna.signName, chart.rashi.signName, chart.panchang.nakshatra, chart.planets.moon.nakshatra.pada,
        JSON.stringify(chart.dashas), JSON.stringify(chart.navamsaSigns), ENGINE_VERSION,
        userId, familyMemberId, relationship || '', billing, qd.base, qd.discount, qd.gst, qd.final, qd.currency || 'INR',
        orderId, chargeable ? (billing === 'PAID' ? 'Paid' : 'Pending') : (billing === 'FREE' ? 'Free' : ''),
        billing === 'PAID' ? 'MOCK' + rid(4) : '', idemKey);

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
      .run(userId, 'kundali.generate', JSON.stringify({ kundaliId, detected: detected.length, recommendations: recs.length, billing }));
    return profileId;
  });
  dbtx();

  /* Razorpay order for chargeable kundalis in gateway mode. */
  let payment = null;
  if (billing === 'PENDING_PAYMENT') {
    payment = await pay.createOrder(quote.final, kundaliId).catch((e) => { throw new HttpError(502, 'Payment gateway error: ' + e.message); });
    db.prepare('UPDATE kundalis SET order_id=? WHERE id=?').run(payment.orderId, kundaliId);
  }

  /* 5. response: the full flow result for the result page */
  const order = { high: 0, medium: 1, low: 2, none: 3 };
  const payload = {
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
    billing: { state: billing, label: bill.label, included: bill.included, family: bill.family, price: base, discount: quote ? quote.discount : 0, gst: quote ? quote.gst : 0, final: quote ? quote.final : 0, currency: quote ? quote.currency : 'INR', orderId, payment },
    disclaimer: 'This analysis follows traditional Jyotish rules on your birth details. It is offered for spiritual guidance and is not a prediction or guarantee of any future event.',
    disclaimerHi: 'यह विश्लेषण आपकी जन्म विवरणों पर पारंपरिक ज्योतिष नियमों के अनुसार है। यह आध्यात्मिक मार्गदर्शन हेतु है — यह किसी भी भविष्य की घटना की भविष्यवाणी या गारंटी नहीं है।'
  };
  if (idemKey && billing !== 'PENDING_PAYMENT') KB.idemPut(idemKey, 'kundali.generate', { kundaliId, billing });
  res.status(201).json(payload);
}));

/* --- GET /mine (customer) --------------------------------------------------- */
router.get('/mine', (req, res) => {
  if (!req.auth || req.auth.role !== 'customer') throw new HttpError(401, 'Please log in');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.auth.uid);
  const rows = db.prepare('SELECT id,name,relationship,billing,price,discount,gst,final_amount,currency,payment_status,order_id,payment_id,created_at FROM kundalis WHERE customer_id=? ORDER BY created_at DESC').all(u.id);
  res.json({
    quota: { included: KB.includedCount(u), used: KB.usedCount(u.id), remaining: Math.max(0, KB.includedCount(u) - KB.usedCount(u.id)) },
    kundalis: rows.map((r) => ({ kundaliId: r.id, name: r.name, relationship: r.relationship || 'Self', billing: r.billing, price: r.price, discount: r.discount, gst: r.gst, final: r.final_amount, currency: r.currency, paymentStatus: r.payment_status, orderId: r.order_id, paymentId: r.payment_id, createdAt: r.created_at }))
  });
});

/* --- GET /:id ------------------------------------------------------------- */
router.get('/:id', wrap(async (req, res) => {
  if (!/^K[a-f0-9]{12}$/.test(req.params.id)) throw new HttpError(404, 'Kundali not found');
  const k = db.prepare('SELECT * FROM kundalis WHERE id=?').get(req.params.id);
  if (!k) throw new HttpError(404, 'Kundali not found');
  /* Ownership: a logged-in user may only open their own kundali; admins (and pandits
     with an assigned booking) may open any. Guests may only use unclaimed links. */
  if (req.auth) {
    if (req.auth.role === 'customer' && k.customer_id && k.customer_id !== req.auth.uid) throw new HttpError(404, 'Kundali not found');
  }
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
    billing: { state: k.billing, relationship: k.relationship || 'Self', final: k.final_amount, currency: k.currency, paymentStatus: k.payment_status },
    place, chart, dashas: JSON.parse(k.dasha_data || '{}'), navamsa: JSON.parse(k.navamsa_data || '{}'),
    doshas, recommendations: recs, engine: k.calculation_version
  });
}));

module.exports = router;
