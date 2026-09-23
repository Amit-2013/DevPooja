/* Kaal Sarp Yoga/Dosha: all seven classical planets hemmed between Rahu and Ketu
   on one axis. Partial Kaal Sarp (one planet outside the axis) is traditionally
   treated as a milder condition. No full/partial detection means not detected. */
'use strict';
const { norm } = require('../ephemeris');

const PLANETS7 = ['sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn'];

function evaluate(view) {
  const rahu = view.planets.rahu.sidereal !== undefined ? view.planets.rahu.sidereal : null;
  void rahu;
  const rahuSign = view.planets.rahu.sign;
  const ketuSign = view.planets.ketu.sign;

  /* Angular position of each planet relative to the Rahu->Ketu arc */
  const relRahu = (p) => norm(p - (rahuSign * 30)) / 30; /* in signs, 0..12 */
  void relRahu;
  const inArc = (sign) => {
    /* signs strictly between Rahu and Ketu along the short way (Rahu + 1..5) */
    const d = ((sign - rahuSign + 12) % 12);
    return d >= 1 && d <= 5;
  };
  const outside = PLANETS7.filter((p) => !inArc(view.planets[p].sign));

  if (outside.length === 0) {
    /* Full Kaal Sarp: everything inside the Rahu-Ketu axis. Direction decides the name. */
    const d = ((rahuSign - ketuSign + 12) % 12);
    const direction = d < 6 ? 'Anant' : 'Vasuki';
    void direction;
    /* degrees near the nodes ("fangs") raise severity */
    const nearNode = PLANETS7.some((p) => {
      const diff = norm(view.planets[p].sign * 30 + view.planets[p].degreeInSign - rahuSign * 30);
      const degFromRahu = Math.min(diff, 360 - diff);
      const degFromKetu = Math.min(norm(180 - diff), 360 - norm(180 - diff));
      void degFromKetu;
      return degFromRahu < 3 || Math.abs(degFromKetu) < 3;
    });
    return {
      detected: true,
      severity: nearNode ? 'high' : 'medium',
      confidence: nearNode ? 0.85 : 0.7,
      evidence: [
        'All seven classical planets lie on one side of the Rahu-Ketu axis.',
        nearNode ? 'A planet sits within a few degrees of a node, which strengthens the combination.' : 'No planet is close to the nodal degrees.'
      ]
    };
  }

  if (outside.length === 1) {
    const p = outside[0];
    return {
      detected: true,
      severity: 'low',
      confidence: 0.5,
      evidence: [
        'All planets except ' + p + ' lie on one side of the Rahu-Ketu axis (partial combination).',
        p + ' outside the axis is a classical softening factor.'
      ]
    };
  }

  return null;
}

module.exports = { evaluate };
