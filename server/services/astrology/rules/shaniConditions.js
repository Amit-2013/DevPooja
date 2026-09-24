/* Shani-related conditions: Sade Sati (Saturn transiting the 12th, 1st and 2nd
   signs from the natal Moon) and a debilitated or 8th-house Saturn.
   NOTE: Sade Sati depends on the CURRENT Saturn position, i.e. it is a transit
   condition, not a fixed birth-chart one. The rule evaluates it as of today and
   says so in the evidence. */
'use strict';
const E = require('../ephemeris');

function evaluate(view, now) {
  const evidence = [], evidenceHi = [];
  let severity = null, confidence = 0;

  /* Transit Sade Sati (as of the evaluation date) */
  const saturnNow = E.positions(now || new Date()).saturn;
  const saturnSign = Math.floor(saturnNow / 30);
  const from = ((saturnSign - view.moonSign + 12) % 12) + 1; /* house from natal Moon */
  if (from === 12 || from === 1 || from === 2) {
    const phase = from === 12 ? 'first (rising) phase' : from === 1 ? 'peak phase' : 'last (setting) phase';
    const phaseHi = from === 12 ? 'प्रथम (उदय) चरण' : from === 1 ? 'शिखर चरण' : 'अंतिम (अस्त) चरण';
    const where = from === 1 ? 'over your natal Moon sign' : 'in the sign adjacent to your natal Moon';
    evidence.push('Saturn is currently transiting ' + where + ' — Sade Sati, ' + phase + '. Transit conditions change with time; your pandit can confirm the current period.');
    evidenceHi.push('शनि इस समय आपकी जन्म चंद्र राशि ' + (from === 1 ? 'पर' : 'के आस-पास की राशि में') + ' गोचर कर रहा है — साढ़े साती, ' + phaseHi + '। गोचर समय के साथ बदलता है; वर्तमान काल आपके पंडित जी से पुष्ट करें।');
    severity = from === 1 ? 'high' : 'medium';
    confidence = 0.85;
  }

  /* Birth-chart Saturn */
  const sat = view.planets.saturn;
  if (sat.dignity === 'Debilitated') { evidence.push('Saturn is debilitated in the birth chart.'); evidenceHi.push('जन्म कुंडली में शनि नीच राशि में है।'); severity = severity || 'medium'; confidence = Math.max(confidence, 0.7); }
  if (sat.house === 8) { evidence.push('Saturn occupies the 8th house in the birth chart.'); evidenceHi.push('जन्म कुंडली में शनि अष्टम भाव में स्थित है।'); severity = severity || 'low'; confidence = Math.max(confidence, 0.6); }

  if (!evidence.length) return null;
  return { detected: true, severity, confidence, evidence, evidenceHi };
}

module.exports = { evaluate };
