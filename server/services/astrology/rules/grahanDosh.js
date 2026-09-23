/* Grahan Dosha: traditionally read when the Sun or Moon is conjunct Rahu or Ketu
   (an eclipse-like combination in the birth chart). */
'use strict';

function evaluate(view) {
  const hits = [];
  for (const lum of ['sun', 'moon']) {
    const L = view.planets[lum];
    for (const node of ['rahu', 'ketu']) {
      const N = view.planets[node];
      if (L.sign === N.sign) {
        const sep = Math.abs(L.degreeInSign - N.degreeInSign);
        hits.push({ luminary: lum, node, separation: +sep.toFixed(1) });
      }
    }
  }
  if (!hits.length) return null;
  const minSep = Math.min(...hits.map((h) => h.separation));
  return {
    detected: true,
    severity: minSep < 5 ? 'high' : minSep < 12 ? 'medium' : 'low',
    confidence: Math.max(0.5, 0.9 - minSep / 25),
    evidence: hits.map((h) =>
      h.luminary.charAt(0).toUpperCase() + h.luminary.slice(1) + ' is in the same sign as ' + h.node +
      ' (about ' + h.separation + '° apart).')
  };
}

module.exports = { evaluate };
