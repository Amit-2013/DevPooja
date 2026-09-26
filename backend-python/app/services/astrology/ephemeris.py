"""Sidereal (Lahiri) planetary positions for the Kundali engine — port of
server/services/astrology/ephemeris.js, line-for-line. No external dependency.

Implements the standard low-precision series from J. Meeus, "Astronomical Algorithms":
- Sun: mean longitude + equation of center (ch. 25)
- Moon: 60-term periodic series (table 47.A) + additive terms (A1, A2, A3)
- Rahu (mean lunar node): Meeus 47.7 with the dominant periodic corrections
- Mercury..Saturn: JPL approximate Keplerian elements, full 3D geocentric reduction

Accuracy: Sun/Moon to ~0.01 deg; Mercury..Mars and Jupiter/Saturn to ~0.07 deg
(outer planets carry the documented error of the Standish approximate elements:
unmodelled long-period mutual perturbations). This is far below the ~1 deg shift
needed to change a nakshatra pada and ~30 deg for a sign — irrelevant for Jyotish use.

All longitudes are in degrees [0,360). Rahu/Ketu are the lunar nodes; Ketu = Rahu+180.
"""
import math
from datetime import datetime, timezone

RAD = math.pi / 180


def norm(x: float) -> float:
    return x % 360.0


def sind(x: float) -> float:
    return math.sin(x * RAD)


def cosd(x: float) -> float:
    return math.cos(x * RAD)


# --- Julian day from a UTC datetime -------------------------------------------
def julian_day(date: datetime) -> float:
    if date.tzinfo is None:
        date = date.replace(tzinfo=timezone.utc)
    # timestamp() is seconds since the epoch; 2440587.5 = JD of 1970-01-01T00:00Z
    return date.timestamp() / 86400.0 + 2440587.5


# centuries since J2000
def _t(jd: float) -> float:
    return (jd - 2451545.0) / 36525.0


# Obliquity of the ecliptic (Meeus 22.2), degrees
def obliquity(tc: float) -> float:
    return 23.439291 - 0.0130042 * tc - 1.64e-7 * tc * tc + 5.04e-7 * tc * tc * tc


# --- Sun: apparent geocentric longitude (Meeus 25) -----------------------------
def sun_lon(tc: float) -> float:
    L0 = 280.46646 + 36000.76983 * tc + 0.0003032 * tc * tc
    M = 357.52911 + 35999.05029 * tc - 0.0001537 * tc * tc
    C = ((1.914602 - 0.004817 * tc - 0.000014 * tc * tc) * sind(M)
         + (0.019993 - 0.000101 * tc) * sind(2 * M) + 0.000289 * sind(3 * M))
    omega = 125.04 - 1934.136 * tc
    return norm(L0 + C - 0.00569 - 0.00478 * sind(omega))


# --- Moon: apparent geocentric longitude (Meeus 47, table 47.A + 47.6 additions)
# [coefficient (0.000001 deg), D, M, M', F]
MOON_TERMS = [
    [6288774, 0, 0, 1, 0], [1274027, 2, 0, -1, 0], [658314, 2, 0, 0, 0],
    [213618, 0, 0, 2, 0], [-185116, 0, 1, 0, 0], [-114332, 0, 0, 0, 2],
    [58793, 2, 0, -2, 0], [57066, 2, -1, -1, 0], [53322, 2, 0, 1, 0],
    [45758, 2, -1, 0, 0], [-40923, 0, 1, -1, 0], [-34720, 1, 0, 0, 0],
    [-30383, 0, 1, 1, 0], [15327, 2, 0, 0, -2], [-12528, 0, 0, 1, 2],
    [10980, 0, 0, 1, -2], [10675, 4, 0, -1, 0], [10034, 0, 0, 3, 0],
    [8548, 4, 0, -2, 0], [-7888, 2, 1, -1, 0], [-6766, 2, 1, 0, 0],
    [-5163, 1, 0, -1, 0], [4987, 1, 1, 0, 0], [4036, 2, -1, 1, 0],
    [3994, 2, 0, 2, 0], [3861, 4, 0, 0, 0], [3665, 2, 0, -3, 0],
    [-2689, 0, 1, -2, 0], [-2602, 2, 0, -1, 2], [2390, 2, -1, -2, 0],
    [-2348, 1, 0, 1, 0], [2236, 2, -2, 0, 0], [-2120, 0, 1, 2, 0],
    [-2069, 0, 2, 0, 0], [2048, 2, -2, -1, 0], [-1773, 2, 0, 1, -2],
    [-1595, 2, 0, 0, 2], [1215, 4, -1, -1, 0], [-1110, 0, 0, 2, 2],
    [-892, 3, 0, -1, 0], [-810, 2, 1, 1, 0], [759, 4, -1, -2, 0],
    [-713, 0, 2, -1, 0], [-700, 2, 2, -1, 0], [691, 2, 1, -2, 0],
    [596, 2, -1, 0, -2], [549, 4, 0, 1, 0], [537, 0, 0, 4, 0],
    [520, 4, -1, 0, 0], [-487, 1, 0, -2, 0], [-399, 2, 1, 0, -2],
    [-381, 0, 0, 2, -2], [351, 1, 1, 1, 0], [-340, 3, 0, -2, 0],
    [330, 4, 0, -3, 0], [327, 2, -1, 2, 0], [-323, 0, 2, 1, 0],
    [299, 1, 1, -1, 0], [294, 2, 0, 3, 0], [266, 2, 0, -1, -2],
]


def moon_lon(tc: float) -> float:
    Lp = 218.3164477 + 481267.88123421 * tc - 0.0015786 * tc * tc + tc * tc * tc / 538841
    D = norm(297.8501921 + 445267.1114034 * tc - 0.0018819 * tc * tc)
    M = norm(357.5291092 + 35999.0502909 * tc - 0.0001536 * tc * tc)
    Mp = norm(134.9633964 + 477198.8675055 * tc + 0.0087414 * tc * tc)
    F = norm(93.272095 + 483202.0175233 * tc - 0.0036539 * tc * tc)
    E = 1 - 0.002516 * tc - 0.0000074 * tc * tc  # eccentricity of earth's orbit
    s = 0.0
    for coef, cD, cM, cMp, cF in MOON_TERMS:
        arg = cD * D + cM * M + cMp * Mp + cF * F
        # Meeus: coefficients carrying M are multiplied by E, by E^2 when |cM| = 2
        k = E if abs(cM) == 1 else E * E if abs(cM) == 2 else 1
        s += coef * k * sind(norm(arg))
    # additive terms (Meeus 47.6), arc-seconds
    A1 = norm(119.75 + 131.849 * tc)
    A2 = norm(53.09 + 479264.29 * tc)
    A3 = norm(313.45 + 481266.484 * tc)
    s += (3958 * sind(A1) + 1962 * sind(Lp - F) + 318 * sind(A2)
          + 178 * sind(norm(Lp - 2 * D + F)) + 175 * sind(A3))
    return norm(Lp + s / 1e6)


# --- Rahu: mean ascending node + dominant periodic corrections (Meeus 47.7) ----
def rahu_lon(tc: float) -> float:
    Om = 125.0445479 - 1934.1362891 * tc + 0.0020754 * tc * tc - tc * tc * tc / 467441
    D = norm(297.8501921 + 445267.1114034 * tc)
    M = norm(357.5291092 + 35999.0502909 * tc)
    Mp = norm(134.9633964 + 477198.8675055 * tc)
    F = norm(93.272095 + 483202.0175233 * tc)
    corr = (-1.4979 * sind(2 * (D - F)) - 0.1500 * sind(M) - 0.1226 * sind(2 * D)
            + 0.1176 * sind(2 * F) - 0.0801 * sind(2 * (Mp - F)))
    return norm(Om + corr)


# --- Mercury..Saturn: JPL approximate Keplerian elements (valid 1800-2050).
# a AU, e, i/omega_Omega/L/wbar in degrees. Each element is [J2000 value, rate per
# Julian century].
PLANETS = {
    "mercury": {"a": [0.38709927, 0.00000037], "e": [0.20563593, 0.00001906],
                "i": [7.00497902, -0.00594749], "L": [252.25032350, 149472.67411175],
                "wbar": [77.45779628, 0.16047689], "O": [48.33076593, -0.12534081]},
    "venus":   {"a": [0.72333566, 0.00000390], "e": [0.00677672, -0.00004107],
                "i": [3.39467605, -0.00078890], "L": [181.97909950, 58517.81538729],
                "wbar": [131.60246718, 0.00268329], "O": [76.67984255, -0.27769418]},
    "mars":    {"a": [1.52371034, 0.00001847], "e": [0.09339410, 0.00007882],
                "i": [1.84969142, -0.00813131], "L": [-4.55343205, 19140.30268499],
                "wbar": [-23.94362959, 0.44441088], "O": [49.55953891, -0.29257343]},
    "jupiter": {"a": [5.20288700, -0.00011607], "e": [0.04838624, -0.00013253],
                "i": [1.30439695, -0.00183714], "L": [34.39644051, 3034.74612775],
                "wbar": [14.72847983, 0.21252668], "O": [100.47390909, 0.20469106]},
    "saturn":  {"a": [9.53667594, -0.00125060], "e": [0.05386179, -0.00050991],
                "i": [2.48599187, 0.00193609], "L": [49.95424423, 1222.49362201],
                "wbar": [92.59887831, -0.41897216], "O": [113.66242448, -0.28867794]},
}


# Heliocentric ecliptic rectangular coordinates (J2000 ecliptic) at time Tc.
# Standard orbital-element reduction: true anomaly from Kepler's equation, then
# rotate by argument of perihelion, inclination and node.
def _helio(name: str, tc: float) -> dict:
    el = PLANETS[name]
    a = el["a"][0] + el["a"][1] * tc
    e = el["e"][0] + el["e"][1] * tc
    i = (el["i"][0] + el["i"][1] * tc) * RAD
    O = (el["O"][0] + el["O"][1] * tc) * RAD          # ascending node
    wbar = norm(el["wbar"][0] + el["wbar"][1] * tc)   # longitude of perihelion
    w = (wbar - el["O"][0] - el["O"][1] * tc) * RAD   # argument of perihelion
    M = norm(el["L"][0] + el["L"][1] * tc - wbar) * RAD  # mean anomaly
    E = M                                             # Kepler equation, Newton iteration
    for _ in range(10):
        E -= (E - e * math.sin(E) - M) / (1 - e * math.cos(E))
    xv = a * (math.cos(E) - e)
    yv = a * math.sqrt(1 - e * e) * math.sin(E)
    v = math.atan2(yv, xv)                            # true anomaly
    r = math.sqrt(xv * xv + yv * yv)
    u = v + w                                         # argument of latitude
    return {
        "x": r * (math.cos(O) * math.cos(u) - math.sin(O) * math.sin(u) * math.cos(i)),
        "y": r * (math.sin(O) * math.cos(u) + math.cos(O) * math.sin(u) * math.cos(i)),
        "z": r * math.sin(u) * math.sin(i),
    }


# Geometric Earth heliocentric vector (AU) in the J2000 ecliptic.
# Direction: opposite the Sun's geometric longitude (apparent series with the
# aberration -0.00569 deg and nutation -0.00478 deg sin(omega) removed, precessed
# back to J2000). Magnitude: Sun's radius vector (Meeus 25.5) — using a unit vector
# here biases the geocentric direction by up to ~1 deg for inner planets.
def _earth_vector(tc: float, prec: float) -> dict:
    omega = 125.04 - 1934.136 * tc
    lam_geo_2000 = sun_lon(tc) + 0.00569 + 0.00478 * sind(omega) - prec
    e = 0.016708634 - 0.000042037 * tc
    M = norm(357.5291092 + 35999.0502909 * tc - 0.0001536 * tc * tc)
    C = ((1.914602 - 0.004817 * tc - 0.000014 * tc * tc) * sind(M)
         + (0.019993 - 0.000101 * tc) * sind(2 * M) + 0.000289 * sind(3 * M))
    r = 1.000001018 * (1 - e * e) / (1 + e * math.cos((M + C) * RAD))
    return {"x": -r * math.cos(lam_geo_2000 * RAD), "y": -r * math.sin(lam_geo_2000 * RAD)}


# Apparent geocentric ecliptic longitude of a planet, degrees [0,360).
# The whole reduction is done in the J2000 ecliptic frame and shifted to the
# ecliptic of date at the end (one precession-in-longitude rotation). Mixing
# frames, or mis-scaling the Earth vector, is catastrophic for nearby planets.
# Residual error is dominated by ignored light-time (< 0.03 deg) and aberration.
def planet_lon(name: str, tc: float) -> float:
    p = _helio(name, tc)
    prec = (5028.796195 * tc + 1.1054348 * tc * tc) / 3600  # precession, degrees
    E = _earth_vector(tc, prec)
    return norm(math.atan2(p["y"] - E["y"], p["x"] - E["x"]) / RAD + prec)


# --- Lahiri ayanamsa: Chitrapaksha. Accurate within a few arc-minutes 1900-2100.
def ayanamsa(jd: float) -> float:
    # Lahiri at J2000.0 ~ 23 deg 51' 11.5" = 23.85319 deg, precession 50.29"/year
    return 23.85319 + (jd - 2451545.0) / 365.25 * (50.29 / 3600)


# Sidereal (Lahiri) longitudes of all bodies used by the engine. date: UTC datetime
def positions(date: datetime) -> dict:
    jd = julian_day(date)
    tc = _t(jd)
    ayan = ayanamsa(jd)

    def sid(lon: float) -> float:
        return norm(lon - ayan)

    out = {
        "sun": sid(sun_lon(tc)),
        "moon": sid(moon_lon(tc)),
        "rahu": sid(rahu_lon(tc)),
        "mercury": sid(planet_lon("mercury", tc)),
        "venus": sid(planet_lon("venus", tc)),
        "mars": sid(planet_lon("mars", tc)),
        "jupiter": sid(planet_lon("jupiter", tc)),
        "saturn": sid(planet_lon("saturn", tc)),
    }
    out["ketu"] = norm(out["rahu"] + 180)
    return out


# Sidereal Ascendant. lat/lon in degrees (east positive); date: UTC datetime
def ascendant(date: datetime, lat: float, lon: float) -> float:
    jd = julian_day(date)
    tc = _t(jd)
    gmst = norm(280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * tc * tc)
    lst = norm(gmst + lon)            # local sidereal time in degrees
    eps = obliquity(tc)
    ramc = lst
    tan_lat = math.tan(lat * RAD)
    asc = math.atan2(
        cosd(ramc),
        -(sind(ramc) * cosd(eps) + tan_lat * sind(eps)),
    ) / RAD
    asc = norm(asc)
    return norm(asc - ayanamsa(jd))   # sidereal = tropical - ayanamsa, same as planets
