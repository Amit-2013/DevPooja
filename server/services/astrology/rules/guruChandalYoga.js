/* Guru Chandal Yoga: traditionally read when Jupiter is conjunct Rahu or Ketu. */
'use strict';
const { DISPLAY_HI } = require('../kundaliEngine');
const NODE_HI = { rahu: 'राहु', ketu: 'केतु' };

function evaluate(view) {
  const J = view.planets.jupiter;
  const hit = ['rahu', 'ketu'].filter((n) => view.planets[n].sign === J.sign)
    .map((n) => ({ node: n, separation: +Math.abs(J.degreeInSign - view.planets[n].degreeInSign).toFixed(1) }));
  if (!hit.length) return null;
  const minSep = Math.min(...hit.map((h) => h.separation));
  return {
    detected: true,
    severity: minSep < 5 ? 'high' : minSep < 12 ? 'medium' : 'low',
    confidence: Math.max(0.5, 0.85 - minSep / 30),
    evidence: hit.map((h) => 'Jupiter is in the same sign as ' + h.node + ' (about ' + h.separation + '° apart).'),
    evidenceHi: hit.map((h) => 'गुरु ' + NODE_HI[h.node] + ' के साथ एक ही राशि में है (लगभग ' + h.separation + '° की दूरी पर)।')
  };
}

module.exports = { evaluate };
