/* Ketu-related conditions: traditionally read when Ketu occupies the 1st, 7th or
   9th house, or is conjunct the Moon. */
'use strict';
const { houseFrom } = require('./helpers');

function evaluate(view) {
  const evidence = [], evidenceHi = [];
  let strength = 0;
  const K = view.planets.ketu;
  const h = houseFrom(K, view.lagnaSign);
  if ([1, 7, 9].includes(h)) { evidence.push('Ketu occupies the ' + h + ordinal(h) + ' house from the lagna.'); evidenceHi.push('केतु लग्न से ' + ({ 1: 'प्रथम', 7: 'सप्तम', 9: 'नवम' }[h]) + ' भाव में स्थित है।'); strength += 1; }
  if (view.planets.moon.sign === K.sign) { evidence.push('The Moon is conjunct Ketu, a traditionally strong Ketu influence on the mind.'); evidenceHi.push('चंद्र की केतु से युति है — पारंपरिक रूप से मन पर केतु का प्रबल प्रभाव माना जाता है।'); strength += 1; }

  if (!evidence.length) return null;
  return {
    detected: true,
    severity: strength >= 2 ? 'high' : 'low',
    confidence: Math.min(0.8, 0.5 + 0.15 * strength),
    evidence,
    evidenceHi
  };
}

function ordinal(n) { return n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'; }

module.exports = { evaluate };
