/* Sidereal (Lahiri) planetary positions for the Kundali engine — no external dependency.

   Implements the standard low-precision series from J. Meeus, "Astronomical Algorithms":
   - Sun: mean longitude + equation of center (ch. 25)
   - Moon: 60-term periodic series (table 47.A) + additive terms (A1, A2, A3)
   - Rahu (mean lunar node): Meeus 47.7 with the dominant periodic corrections
   - Mercury..Saturn: JPL approximate Keplerian elements, full 3D geocentric reduction
   Accuracy: Sun/Moon to ~0.01°; Mercury..Mars and Jupiter/Saturn to ~0.07°
   (outer planets carry the documented error of the Standish approximate elements:
   unmodelled long-period mutual perturbations). This is far below the ~1° shift
   needed to change a nakshatra pada and ~30° for a sign — irrelevant for Jyotish use.

   All longitudes are in degrees [0,360). Rahu/Ketu are the lunar nodes; Ketu = Rahu+180. */
'use strict';

const RAD = Math.PI / 180;
const norm = (x) => ((x % 360) + 360) % 360;
const sind = (x) => Math.sin(x * RAD);
const cosd = (x) => Math.cos(x * RAD);

/* Julian day from a UTC Date */
function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/* centuries since J2000 */
const T = (jd) => (jd - 2451545.0) / 36525;

/* Obliquity of the ecliptic (Meeus 22.2), degrees */
function obliquity(Tc) {
  return 23.439291 - 0.0130042 * Tc - 1.64e-7 * Tc * Tc + 5.04e-7 * Tc * Tc * Tc;
}

/* --- Sun: apparent geocentric longitude (Meeus 25) --- */
function sunLon(Tc) {
  const L0 = 280.46646 + 36000.76983 * Tc + 0.0003032 * Tc * Tc;
  const M = 357.52911 + 35999.05029 * Tc - 0.0001537 * Tc * Tc;
  const C = (1.914602 - 0.004817 * Tc - 0.000014 * Tc * Tc) * sind(M)
    + (0.019993 - 0.000101 * Tc) * sind(2 * M) + 0.000289 * sind(3 * M);
  const omega = 125.04 - 1934.136 * Tc;
  return norm(L0 + C - 0.00569 - 0.00478 * sind(omega));
}

/* --- Moon: apparent geocentric longitude (Meeus 47, table 47.A main terms + 47.6 additions) --- */
const MOON_TERMS = [
  [6288774, 0, 0, 1], [1274027, 2, 0, -1], [658314, 2, 0, 0], [213618, 0, 0, 2],
  [-185116, 0, 1, 0], [-114332, 0, 0, 0, 2], [58793, 2, 0, -2], [57066, 2, -1, -1],
  [53322, 2, 0, 1], [45758, 2, -1, 0], [-40923, 0, 1, -1], [-34720, 1, 0, 0],
  [-30383, 0, 1, 1], [15327, 2, 0, 0, -2], [-12528, 0, 0, 1, 2], [10980, 0, 0, 1, -2],
  [10675, 4, 0, -1], [10034, 0, 0, 3], [8548, 4, 0, -2], [-7888, 2, 1, -1],
  [-6766, 2, 1, 0], [-5163, 1, 0, -1], [4987, 1, 1, 0], [4036, 2, -1, 1],
  [3994, 2, 0, 2], [3861, 4, 0, 0], [3665, 2, 0, -3], [-2689, 0, 1, -2],
  [-2602, 2, 0, -1, 2], [2390, 2, -1, -2], [-2348, 1, 0, 1], [2236, 2, -2, 0],
  [-2120, 0, 1, 2], [-2069, 0, 2, 0], [2048, 2, -2, -1], [-1773, 2, 0, 1, -2],
  [-1595, 2, 0, 0, 2], [1215, 4, -1, -1], [-1110, 0, 0, 2, 2], [-892, 3, 0, -1],
  [-810, 2, 1, 1], [759, 4, -1, -2], [-713, 0, 2, -1], [-700, 2, 2, -1],
  [691, 2, 1, -2], [596, 2, -1, 0, -2], [549, 4, 0, 1], [537, 0, 0, 4],
  [520, 4, -1, 0], [-487, 1, 0, -2], [-399, 2, 1, 0, -2], [-381, 0, 0, 2, -2],
  [351, 1, 1, 1], [-340, 3, 0, -2], [330, 4, 0, -3], [327, 2, -1, 2],
  [-323, 0, 2, 1], [299, 1, 1, -1], [294, 2, 0, 3], [266, 2, 0, -1, -2]
];

function moonLon(Tc) {
  const Lp = 218.3164477 + 481267.88123421 * Tc - 0.0015786 * Tc * Tc + Tc * Tc * Tc / 538841;
  const D = norm(297.8501921 + 445267.1114034 * Tc - 0.0018819 * Tc * Tc);
  const M = norm(357.5291092 + 35999.0502909 * Tc - 0.0001536 * Tc * Tc);
  const Mp = norm(134.9633964 + 477198.8675055 * Tc + 0.0087414 * Tc * Tc);
  const F = norm(93.272095 + 483202.0175233 * Tc - 0.0036539 * Tc * Tc);
  const E = 1 - 0.002516 * Tc - 0.0000074 * Tc * Tc; /* eccentricity of earth's orbit */
  let sum = 0;
  for (const [coef, cD, cM, cMp, cF] of MOON_TERMS) {
    const arg = cD * D + cM * M + cMp * Mp + (cF || 0) * F;
    /* Meeus: coefficients carrying M are multiplied by E, by E^2 when |cM| = 2 */
    const k = Math.abs(cM) === 1 ? E : Math.abs(cM) === 2 ? E * E : 1;
    sum += coef * k * sind(norm(arg));
  }
  /* additive terms (Meeus 47.6), arc-seconds */
  const A1 = norm(119.75 + 131.849 * Tc), A2 = norm(53.09 + 479264.29 * Tc), A3 = norm(313.45 + 481266.484 * Tc);
  sum += 3958 * sind(A1) + 1962 * sind(Lp - F) + 318 * sind(A2) + 178 * sind(norm(Lp - 2 * D + F)) + 175 * sind(A3);
  return norm(Lp + sum / 1e6);
}

/* --- Rahu: mean ascending node + dominant periodic corrections (Meeus 47.7) --- */
function rahuLon(Tc) {
  const Om = 125.0445479 - 1934.1362891 * Tc + 0.0020754 * Tc * Tc - Tc * Tc * Tc / 467441;
  const D = norm(297.8501921 + 445267.1114034 * Tc);
  const M = norm(357.5291092 + 35999.0502909 * Tc);
  const Mp = norm(134.9633964 + 477198.8675055 * Tc);
  const F = norm(93.272095 + 483202.0175233 * Tc);
  const corr =
    -1.4979 * sind(2 * (D - F)) - 0.1500 * sind(M) - 0.1226 * sind(2 * D)
    + 0.1176 * sind(2 * F) - 0.0801 * sind(2 * (Mp - F));
  return norm(Om + corr);
}

/* --- Mercury..Saturn: JPL approximate Keplerian elements (valid 1800-2050).
     a AU, e, i/Ω/L/wbar degrees. Each element is [value at J2000, rate per Julian century]. */
const PLANETS = {
  mercury: { a: [0.38709927, 0.00000037], e: [0.20563593, 0.00001906], i: [7.00497902, -0.00594749], L: [252.25032350, 149472.67411175], wbar: [77.45779628, 0.16047689], O: [48.33076593, -0.12534081] },
  venus:   { a: [0.72333566, 0.00000390], e: [0.00677672, -0.00004107], i: [3.39467605, -0.00078890], L: [181.97909950, 58517.81538729], wbar: [131.60246718, 0.00268329], O: [76.67984255, -0.27769418] },
  mars:    { a: [1.52371034, 0.00001847], e: [0.09339410, 0.00007882], i: [1.84969142, -0.00813131], L: [-4.55343205, 19140.30268499], wbar: [-23.94362959, 0.44441088], O: [49.55953891, -0.29257343] },
  jupiter: { a: [5.20288700, -0.00011607], e: [0.04838624, -0.00013253], i: [1.30439695, -0.00183714], L: [34.39644051, 3034.74612775], wbar: [14.72847983, 0.21252668], O: [100.47390909, 0.20469106] },
  saturn:  { a: [9.53667594, -0.00125060], e: [0.05386179, -0.00050991], i: [2.48599187, 0.00193609], L: [49.95424423, 1222.49362201], wbar: [92.59887831, -0.41897216], O: [113.66242448, -0.28867794] }
};

/* Heliocentric ecliptic rectangular coordinates (J2000 ecliptic) at time Tc.
   Standard orbital-element reduction: true anomaly from Kepler's equation,
   then rotate by argument of perihelion, inclination and node. */
function helio(name, Tc) {
  const el = PLANETS[name];
  const a = el.a[0] + el.a[1] * Tc;
  const e = el.e[0] + el.e[1] * Tc;
  const I = (el.i[0] + el.i[1] * Tc) * RAD;
  const O = (el.O[0] + el.O[1] * Tc) * RAD;          /* ascending node */
  const wbar = norm(el.wbar[0] + el.wbar[1] * Tc);   /* longitude of perihelion */
  const w = (wbar - el.O[0] - el.O[1] * Tc) * RAD;   /* argument of perihelion */
  const M = norm(el.L[0] + el.L[1] * Tc - wbar) * RAD; /* mean anomaly */
  let E = M;                                         /* Kepler equation, Newton iteration */
  for (let k = 0; k < 10; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xv = a * (Math.cos(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const v = Math.atan2(yv, xv);                      /* true anomaly */
  const r = Math.sqrt(xv * xv + yv * yv);
  const u = v + w;                                   /* argument of latitude */
  return {
    x: r * (Math.cos(O) * Math.cos(u) - Math.sin(O) * Math.sin(u) * Math.cos(I)),
    y: r * (Math.sin(O) * Math.cos(u) + Math.cos(O) * Math.sin(u) * Math.cos(I)),
    z: r * Math.sin(u) * Math.sin(I)
  };
}

/* Geometric Earth heliocentric vector (AU) in the J2000 ecliptic.
   Direction: opposite the Sun's geometric longitude (apparent series with the
   aberration −0.00569° and nutation −0.00478°sinΩ removed, precessed back to J2000).
   Magnitude: Sun's radius vector (Meeus 25.5) — using a unit vector here biases the
   geocentric direction by up to ~1° for inner planets (error scales with r_E/Δ and
   vanishes only when the target is radially aligned with the Sun). */
function earthVector(Tc, prec) {
  const omega = 125.04 - 1934.136 * Tc;
  const lamGeo2000 = sunLon(Tc) + 0.00569 + 0.00478 * sind(omega) - prec;
  const e = 0.016708634 - 0.000042037 * Tc;
  const M = norm(357.5291092 + 35999.0502909 * Tc - 0.0001536 * Tc * Tc);
  const C = (1.914602 - 0.004817 * Tc - 0.000014 * Tc * Tc) * sind(M)
    + (0.019993 - 0.000101 * Tc) * sind(2 * M) + 0.000289 * sind(3 * M);
  const r = 1.000001018 * (1 - e * e) / (1 + e * Math.cos((M + C) * RAD));
  return { x: -r * Math.cos(lamGeo2000 * RAD), y: -r * Math.sin(lamGeo2000 * RAD) };
}

/* Apparent geocentric ecliptic longitude of a planet, degrees [0,360).
   The whole reduction is done in the J2000 ecliptic frame and shifted to the
   ecliptic of date at the end (one precession-in-longitude rotation). Mixing
   frames, or mis-scaling the Earth vector, is catastrophic for nearby planets.
   Residual error is dominated by ignored light-time (< 0.03°) and aberration. */
function planetLon(name, Tc) {
  const p = helio(name, Tc);
  const prec = (5028.796195 * Tc + 1.1054348 * Tc * Tc) / 3600; /* precession, degrees */
  const E = earthVector(Tc, prec);
  return norm(Math.atan2(p.y - E.y, p.x - E.x) / RAD + prec);
}

/* --- Lahiri ayanamsa: Chitrapaksha. Accurate within a few arc-minutes 1900-2100. --- */
function ayanamsa(jd) {
  /* Lahiri at J2000.0 ≈ 23°51'11.5" = 23.85319°, precession 50.29"/year */
  return 23.85319 + (jd - 2451545.0) / 365.25 * (50.29 / 3600);
}

/* Sidereal (Lahiri) longitudes of all bodies used by the engine. date: UTC Date */
function positions(date) {
  const jd = julianDay(date), Tc = T(jd);
  const ayan = ayanamsa(jd);
  const sid = (lon) => norm(lon - ayan);
  const out = {
    sun: sid(sunLon(Tc)),
    moon: sid(moonLon(Tc)),
    rahu: sid(rahuLon(Tc)),
    mercury: sid(planetLon('mercury', Tc)),
    venus: sid(planetLon('venus', Tc)),
    mars: sid(planetLon('mars', Tc)),
    jupiter: sid(planetLon('jupiter', Tc)),
    saturn: sid(planetLon('saturn', Tc))
  };
  out.ketu = norm(out.rahu + 180);
  return out;
}

/* Sidereal Ascendant. lat/lon in degrees (east positive); date: UTC Date */
function ascendant(date, lat, lon) {
  const jd = julianDay(date), Tc = T(jd);
  const gmst = norm(280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * Tc * Tc);
  const lst = norm(gmst + lon);                       /* local sidereal time in degrees */
  const eps = obliquity(Tc);
  const ramc = lst;
  const tanLat = Math.tan(lat * RAD);
  let asc = Math.atan2(
    cosd(ramc),
    -(sind(ramc) * cosd(eps) + tanLat * sind(eps))
  ) / RAD;
  asc = norm(asc);
  return norm(asc - ayanamsa(jd)); /* sidereal = tropical - ayanamsa, same as planets */
}

module.exports = { positions, ascendant, ayanamsa, norm, julianDay };
