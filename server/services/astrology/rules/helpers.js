/* Shared helpers for dosh rules. Every rule is a pure function of the analysis view:
   it receives { lagnaSign, moonSign, planets:{...}, dasha } and returns
   null (not detected) or { detected:true, severity, confidence, evidence:[...] }. */
'use strict';

const HOUSES_HIGH = [7, 8];

/* House of a planet counted from a reference sign (1-based). */
const houseFrom = (planet, refSign) => ((planet.sign - refSign + 12) % 12) + 1;

/* Same-sign conjunction (whole-sign, the whole-sign houses the chart already uses). */
const withPlanets = (view, refSign) =>
  Object.entries(view.planets).map(([name, p]) => ({ name, house: houseFrom(p, refSign), sign: p.sign }));

const exalted = (p) => p.dignity === 'Exalted';
const debilitated = (p) => p.dignity === 'Debilitated';
const ownSign = (p) => p.dignity === 'Own sign';

module.exports = { HOUSES_HIGH, houseFrom, withPlanets, exalted, debilitated, ownSign };
