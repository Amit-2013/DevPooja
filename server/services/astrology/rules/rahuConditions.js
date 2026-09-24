/* Rahu-related conditions: a strong Rahu influence is traditionally read when Rahu
   sits in the 3rd, 6th, 10th or 11th (its "good" houses — traditionally NOT flagged),
   so this rule only flags the difficult placements: Rahu in the 1st, 5th, 8th or 9th,
   or Rahu conjunct the Moon. */
'use strict';
const { houseFrom } = require('./helpers');

function evaluate(view) {
  const evidence = [], evidenceHi = [];
  let strength = 0;
  const R = view.planets.rahu;
  const h = houseFrom(R, view.lagnaSign);
  if ([1, 5, 8, 9].includes(h)) { const s = ('Rahu occupies the ' + h + 'th house from the lagna.').replace('1th', '1st').replace('2th', '2nd').replace('3th', '3rd'); evidence.push(s); evidenceHi.push('राहु लग्न से ' + ({ 1: 'प्रथम', 5: 'पंचम', 8: 'अष्टम', 9: 'नवम' }[h]) + ' भाव में स्थित है।'); strength += 1; }
  if (view.planets.moon.sign === R.sign) { evidence.push('The Moon is conjunct Rahu, a traditionally strong Rahu influence on the mind.'); evidenceHi.push('चंद्र की राहु से युति है — पारंपरिक रूप से मन पर राहु का प्रबल प्रभाव माना जाता है।'); strength += 1; }

  if (!evidence.length) return null;
  return {
    detected: true,
    severity: strength >= 2 ? 'high' : 'medium',
    confidence: Math.min(0.85, 0.55 + 0.15 * strength),
    evidence,
    evidenceHi
  };
}

module.exports = { evaluate };
