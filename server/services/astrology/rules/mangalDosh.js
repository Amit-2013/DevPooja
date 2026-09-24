/* Mangal Dosha / Kuja Dosha: Mars in houses 1, 2, 4, 7, 8 or 12 counted from the
   lagna (and additionally from the Moon and Venus in South Indian tradition).
   Cancellation (classic exceptions): Mars in its own sign or exaltation, Mars
   aspected by Jupiter, or the matching house occupied by a benefic. */
'use strict';
const { HOUSES_HIGH, houseFrom, exalted, ownSign } = require('./helpers');

const DOSHA_HOUSES = [1, 2, 4, 7, 8, 12];

function evaluate(view) {
  const refs = [
    ['lagna', view.lagnaSign],
    ['Moon (Chandra lagna)', view.moonSign],
    ['Venus', view.planets.venus.sign]
  ];
  const hits = [];
  for (const [refName, refSign] of refs) {
    const house = houseFrom(view.planets.mars, refSign);
    if (DOSHA_HOUSES.includes(house)) hits.push({ ref: refName, house });
  }

  /* Cancellation checks on the strongest reference (from the lagna) */
  const mars = view.planets.mars;
  const houseFromLagna = houseFrom(mars, view.lagnaSign);
  const cancellations = [];
  if (exalted(mars)) cancellations.push('Mars is exalted, a classical cancellation.');
  if (ownSign(mars)) cancellations.push('Mars is in its own sign, a classical cancellation.');
  if (HOUSES_HIGH.includes(houseFromLagna) && (view.planets.jupiter.sign === mars.sign || (houseFrom(view.planets.jupiter, view.lagnaSign) === houseFromLagna))) {
    cancellations.push('Jupiter occupies or aspects the same house, a classical cancellation.');
  }

  if (!hits.length) return null;

  const primary = hits[0];
  const severity =
    cancellations.length ? 'low'
      : HOUSES_HIGH.includes(primary.house) ? 'high'
        : DOSHA_HOUSES.slice(0, 3).includes(primary.house) ? 'medium' : 'medium';

  const confidence = Math.min(0.95, 0.55 + 0.1 * hits.length + (cancellations.length ? -0.15 : 0.1));

  const HOUSE_HI = { 1: 'प्रथम', 2: 'द्वितीय', 4: 'चतुर्थ', 7: 'सप्तम', 8: 'अष्टम', 12: 'द्वादश' };
  const REF_HI = { lagna: 'लग्न', 'Moon (Chandra lagna)': 'चंद्र लग्न', Venus: 'शुक्र' };
  const evidenceHi = [
    'मंगल ' + REF_HI[primary.ref] + ' से ' + HOUSE_HI[primary.house] + ' भाव में स्थित है।',
    ...hits.slice(1).map((h) => 'मंगल ' + (REF_HI[h.ref] || h.ref) + ' से ' + (HOUSE_HI[h.house] || h.house) + ' भाव में भी स्थित है।'),
    ...cancellations.map((c) => c.includes('exalted') ? 'मंगल उच्च राशि में है — यह पारंपरिक रूप से दोष का शमन माना जाता है।'
      : c.includes('own sign') ? 'मंगल अपनी राशि (स्वराशि) में है — यह पारंपरिक रूप से दोष का शमन माना जाता है।'
        : 'गुरु उसी भाव में स्थित है या उस पर दृष्टि रखता है — यह पारंपरिक रूप से दोष का शमन माना जाता है।')
  ];

  return {
    detected: true,
    severity,
    confidence: +confidence.toFixed(2),
    evidence: [
      'Mars is in the ' + primary.house + ordinal(primary.house) + ' house from the ' + primary.ref + '.',
      ...hits.slice(1).map((h) => 'Mars is also in the ' + h.house + ordinal(h.house) + ' house from the ' + h.ref + '.'),
      ...cancellations
    ],
    evidenceHi
  };
}

function ordinal(n) { return n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'; }

module.exports = { evaluate, DOSHA_HOUSES };
