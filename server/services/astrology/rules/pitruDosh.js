/* Pitru Dosha: traditionally read when the Sun, Rahu or Ketu occupy the 9th house,
   or when the 9th lord is with Rahu/Ketu. The 9th stands for ancestors and dharma. */
'use strict';
const { houseFrom } = require('./helpers');

function evaluate(view) {
  const evidence = [];
  let strength = 0;

  for (const p of ['sun', 'rahu', 'ketu']) {
    const h = houseFrom(view.planets[p], view.lagnaSign);
    if (h === 9) { evidence.push(p.charAt(0).toUpperCase() + p.slice(1) + ' occupies the 9th house of ancestors.'); strength += p === 'sun' ? 1 : 0.5; }
  }
  const ninthSign = (view.lagnaSign + 8) % 12;
  const ninthLord = view.planets.sun.sign === ninthSign ? 'sun' : null; /* placeholder, computed below */
  void ninthLord;
  /* find the classical lord of the 9th sign */
  const LORDS_BY_SIGN = ['mars', 'venus', 'mercury', 'moon', 'sun', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'saturn', 'jupiter'];
  const lordName = LORDS_BY_SIGN[ninthSign];
  const lord = view.planets[lordName];
  if (lord.sign === view.planets.rahu.sign || lord.sign === view.planets.ketu.sign) {
    evidence.push('The lord of the 9th house (' + lordName + ') is conjunct a lunar node.');
    strength += 1;
  }

  if (!evidence.length) return null;
  const severity = strength >= 2 ? 'high' : strength >= 1 ? 'medium' : 'low';
  return {
    detected: true,
    severity,
    confidence: Math.min(0.9, 0.5 + 0.15 * strength),
    evidence
  };
}

module.exports = { evaluate };
