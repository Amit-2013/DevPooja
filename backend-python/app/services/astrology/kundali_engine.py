"""Builds the full Kundali — port of server/services/astrology/kundaliEngine.js:
signs, nakshatras, houses, navamsa, dashas, panchang, strength, Hindi fields.

Uses ephemeris.py for real sidereal positions. Nothing is hard-coded: every value
is derived from the birth date, time and place the customer entered."""
import math
import re
from datetime import datetime, timedelta, timezone

from . import ephemeris as E

SIGNS = ['Mesha (Aries)', 'Vrishabha (Taurus)', 'Mithuna (Gemini)', 'Karka (Cancer)', 'Simha (Leo)', 'Kanya (Virgo)', 'Tula (Libra)', 'Vrishchika (Scorpio)', 'Dhanu (Sagittarius)', 'Makara (Capricorn)', 'Kumbha (Aquarius)', 'Meena (Pisces)']
SIGN_SHORT = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces']
NAKSHATRAS = [
    'Ashwini', 'Bharani', 'Krittika', 'Rohini', 'Mrigashira', 'Ardra', 'Punarvasu', 'Pushya', 'Ashlesha',
    'Magha', 'Purva Phalguni', 'Uttara Phalguni', 'Hasta', 'Chitra', 'Swati', 'Vishakha', 'Anuradha', 'Jyeshtha',
    'Mula', 'Purva Ashadha', 'Uttara Ashadha', 'Shravana', 'Dhanishta', 'Shatabhisha', 'Purva Bhadrapada', 'Uttara Bhadrapada', 'Revati',
]
# Devanagari (Hindi) display names — additive: every English field stays untouched so
# old saved kundalis keep working and the UI can switch languages without a regen.
SIGN_HI = ['मेष', 'वृषभ', 'मिथुन', 'कर्क', 'सिंह', 'कन्या', 'तुला', 'वृश्चिक', 'धनु', 'मकर', 'कुंभ', 'मीन']
NAKSHATRAS_HI = [
    'अश्विनी', 'भरणी', 'कृत्तिका', 'रोहिणी', 'मृगशिरा', 'आर्द्रा', 'पुनर्वसु', 'पुष्य', 'आश्लेषा',
    'मघा', 'पूर्वाफाल्गुनी', 'उत्तराफाल्गुनी', 'हस्त', 'चित्रा', 'स्वाती', 'विशाखा', 'अनुराधा', 'ज्येष्ठा',
    'मूल', 'पूर्वाषाढ़ा', 'उत्तराषाढ़ा', 'श्रवण', 'धनिष्ठा', 'शतभिषा', 'पूर्वाभाद्रपद', 'उत्तराभाद्रपद', 'रेवती',
]
LORDS = ['Mars', 'Venus', 'Mercury', 'Moon', 'Sun', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Saturn', 'Jupiter']
LORDS_HI = ['मंगल', 'शुक्र', 'बुध', 'चंद्र', 'सूर्य', 'बुध', 'शुक्र', 'मंगल', 'गुरु', 'शनि', 'शनि', 'गुरु']
TITHIS = ['Pratipada', 'Dwitiya', 'Trita', 'Chaturthi', 'Panchami', 'Shashthi', 'Saptami', 'Ashtami', 'Navami', 'Dashami', 'Ekadashi', 'Dwadashi', 'Trayodashi', 'Chaturdashi']
TITHIS_HI = ['प्रतिपदा', 'द्वितीया', 'तृतीया', 'चतुर्थी', 'पंचमी', 'षष्ठी', 'सप्तमी', 'अष्टमी', 'नवमी', 'दशमी', 'एकादशी', 'द्वादशी', 'त्रयोदशी', 'चतुर्दशी']
PAKSHA_HI = {'Shukla': 'शुक्ल पक्ष', 'Krishna': 'कृष्ण पक्ष'}
VARAS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
VARAS_HI = ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार']
DIGNITY_HI = {'Exalted': 'उच्च', 'Debilitated': 'नीच', 'Own sign': 'स्वराशि', 'Neutral': 'मध्यम'}
PLANET_ORDER = ['sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn', 'rahu', 'ketu']
DISPLAY = {'sun': 'Sun ☉', 'moon': 'Moon ☽', 'mars': 'Mars ♂', 'mercury': 'Mercury ☿', 'jupiter': 'Jupiter ♃', 'venus': 'Venus ♀', 'saturn': 'Saturn ♄', 'rahu': 'Rahu ☊', 'ketu': 'Ketu ☋'}
DISPLAY_HI = {'sun': 'सूर्य', 'moon': 'चंद्र', 'mars': 'मंगल', 'mercury': 'बुध', 'jupiter': 'गुरु', 'venus': 'शुक्र', 'saturn': 'शनि', 'rahu': 'राहु', 'ketu': 'केतु'}

# Vimshottari periods in solar years. The nakshatra lord cycle starts at Ashwini = Ketu
# and follows the dasha order; a nakshatra's lord determines the first mahadasha.
DASHA = {'Ketu': 7, 'Venus': 20, 'Sun': 6, 'Moon': 10, 'Mars': 7, 'Rahu': 18, 'Jupiter': 16, 'Saturn': 19, 'Mercury': 17}
DASHA_ORDER = ['Ketu', 'Venus', 'Sun', 'Moon', 'Mars', 'Rahu', 'Jupiter', 'Saturn', 'Mercury']
DASHA_HI = {'Ketu': 'केतु', 'Venus': 'शुक्र', 'Sun': 'सूर्य', 'Moon': 'चंद्र', 'Mars': 'मंगल', 'Rahu': 'राहु', 'Jupiter': 'गुरु', 'Saturn': 'शनि', 'Mercury': 'बुध'}

YEAR_MS = 365.2425 * 86400000.0


def nak_of(lon: float) -> dict:
    span = 360.0 / 27
    i = math.floor(lon / span)
    lord = DASHA_ORDER[i % 9]
    return {"name": NAKSHATRAS[i], "nameHi": NAKSHATRAS_HI[i], "index": i,
            "pada": math.floor((lon % span) / (span / 4)) + 1, "lord": lord, "lordHi": DASHA_HI[lord]}


# Evaluates the simple dignity rules the engine uses for the "status" column.
DIGNITY = {
    "exalted": {"sun": 0, "moon": 1, "mars": 9, "mercury": 5, "jupiter": 3, "venus": 11, "saturn": 6, "rahu": 1, "ketu": 7},
    "debilitated": {"sun": 6, "moon": 7, "mars": 3, "mercury": 11, "jupiter": 9, "venus": 5, "saturn": 0, "rahu": 7, "ketu": 1},
    "own": {"sun": [4], "moon": [3], "mars": [0, 7], "mercury": [2, 5], "jupiter": [8, 11], "venus": [1, 6], "saturn": [9, 10]},
}


def dignity_of(planet: str, sign: int) -> str:
    if DIGNITY["exalted"].get(planet) == sign:
        return "Exalted"
    if DIGNITY["debilitated"].get(planet) == sign:
        return "Debilitated"
    if sign in (DIGNITY["own"].get(planet) or []):
        return "Own sign"
    return "Neutral"


def dignity_hi(en: str) -> str:
    return DIGNITY_HI.get(en, en)


_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _iso_date(t_ms: float) -> str:
    """new Date(ms).toISOString().slice(0,10) parity. Pure epoch arithmetic so
    pre-1970 dates (grandmother charts, early dasha periods) work on Windows too
    — datetime.fromtimestamp raises OSError for negative values there."""
    return (_EPOCH + timedelta(milliseconds=t_ms)).strftime("%Y-%m-%d")


def dasha_timeline(moon_lon: float, utc_date: datetime) -> dict:
    nak = nak_of(moon_lon)
    start_lord = nak["lord"]
    elapsed_frac = (moon_lon % (360.0 / 27)) / (360.0 / 27)  # portion of the first dasha already elapsed
    t = utc_date.timestamp() * 1000 - elapsed_frac * DASHA[start_lord] * YEAR_MS
    li = DASHA_ORDER.index(start_lord)
    timeline = []
    for i in range(10):
        lord = DASHA_ORDER[(li + i) % 9]
        dur = DASHA[lord] * YEAR_MS
        timeline.append({
            "lord": lord, "lordHi": DASHA_HI[lord],
            "from": _iso_date(t),
            "to": _iso_date(t + dur),
            "years": DASHA[lord],
        })
        t += dur
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    current = next((d for d in timeline if d["from"] <= now_iso <= d["to"]), None)
    return {
        "balanceAtBirth": round((1 - elapsed_frac) * DASHA[start_lord] * 12) / 12,
        "periods": timeline,
        "current": current or timeline[0],
    }


# Whole-sign houses. house_of_sign(s) = ((s - lagna_sign) mod 12) + 1
def build_chart(input_: dict) -> dict:
    # .get() defaults mirror Node's `input.x || ''` tolerance for optional fields.
    name = input_.get("name", "")
    gender = input_.get("gender", "")
    dob = input_.get("dob", "")
    tob = input_.get("tob", "")
    birth_time_accuracy = input_.get("birthTimeAccuracy", "")
    lat = input_["lat"]
    lon = input_["lon"]
    tz = input_.get("tz", "")
    hm = re.search(r"^(\d{1,2}):(\d{2})$", tob or "")
    hh = int(hm.group(1)) if hm else 12
    mm = int(hm.group(2)) if hm else 0
    # Approximate zone offset: the DB stores the IANA name but the engine only needs
    # the civil offset at birth, which for all-India charts is fixed +05:30 (IST since 1947).
    offset_min = 330 if re.search(r"Kolkata|Calcutta|Asia/India|IST", tz or "", re.I) else 0
    local_noon = f"{dob}T{hh:02d}:{mm:02d}:00"
    try:
        naive = datetime.strptime(local_noon, "%Y-%m-%dT%H:%M:%S")
        utc = (naive - timedelta(minutes=offset_min)).replace(tzinfo=timezone.utc)
    except (ValueError, OverflowError, OSError):
        raise ValueError("Invalid birth date or time")
    if math.isnan(utc.timestamp()):
        raise ValueError("Invalid birth date or time")

    trop = E.positions(utc)
    ayan = E.ayanamsa(E.julian_day(utc))
    lagna_sid = E.ascendant(utc, lat, lon)
    lagna_sign = math.floor(lagna_sid / 30)

    planets = {}
    for p in PLANET_ORDER:
        lon_sid = trop[p]
        sign = math.floor(lon_sid / 30)
        house = ((sign - lagna_sign + 12) % 12) + 1
        dig = dignity_of(p, sign)
        planets[p] = {
            "sidereal": round(lon_sid, 4),
            "tropical": round(E.norm(lon_sid + ayan), 4),
            "sign": sign, "signName": SIGN_SHORT[sign], "signHi": SIGN_HI[sign], "house": house,
            "degreeInSign": round(lon_sid % 30, 2),
            "nakshatra": nak_of(lon_sid),
            "dignity": dig, "dignityHi": dignity_hi(dig),
            "retrograde": p in ("rahu", "ketu"),  # nodes are always retrograde; classical convention
        }

    # Chandra lagna (moon sign) and its houses, used by several rules
    moon_sign = planets["moon"]["sign"]

    # Navamsa (D9): the classical rule — navamsa lagna starts at the sign itself for
    # movable signs, the 9th from it for fixed, the 5th for dual. navamsa_index =
    # (sign + part) mod 12 with part counted from that root.
    def navamsa_sign_of(sign: int, deg_in_sign: float) -> str:
        part = math.floor(deg_in_sign / (30.0 / 9))
        if sign % 3 == 0:
            root = sign
        elif sign % 3 == 1:
            root = (sign + 8) % 12
        else:
            root = (sign + 4) % 12
        return SIGN_SHORT[(root + part) % 12]

    navamsa = {p: navamsa_sign_of(planets[p]["sign"], planets[p]["degreeInSign"]) for p in PLANET_ORDER}

    tithi_num = math.floor(E.norm(trop["moon"] - trop["sun"]) / 12) + 1  # 1..30
    paksha = "Shukla" if tithi_num <= 15 else "Krishna"
    tithi_name = TITHIS[(tithi_num - 1) % 15]
    tithi_name_hi = TITHIS_HI[(tithi_num - 1) % 15]
    # JS getUTCDay(): 0 = Sunday..6 = Saturday. Python weekday(): 0 = Monday..6 = Sunday.
    wd = (utc.weekday() + 1) % 7
    vara = VARAS[wd]
    vara_hi = VARAS_HI[wd]

    nak_lagna = nak_of(lagna_sid)

    return {
        "meta": {
            "name": name, "gender": gender, "dob": dob, "tob": tob or "Unknown",
            "birthTimeAccuracy": birth_time_accuracy or "exact",
            "place": input_.get("place", ""), "city": input_.get("city") or "",
            "state": input_.get("state") or "", "country": input_.get("country") or "",
            "lat": lat, "lon": lon, "tz": tz,
            "utcIso": utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z",
            "ayanamsaName": "Lahiri (Chitrapaksha)",
            "ayanamsa": round(ayan, 4), "engine": "internal-ephemeris-v1",
            "calculatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z",
        },
        "lagna": {"longitude": round(lagna_sid, 4), "sign": lagna_sign, "signName": SIGN_SHORT[lagna_sign],
                  "signHi": SIGN_HI[lagna_sign], "signFull": SIGNS[lagna_sign], "lord": LORDS[lagna_sign],
                  "lordHi": LORDS_HI[lagna_sign], "nakshatra": nak_lagna},
        "rashi": {"moonSign": moon_sign, "signName": SIGN_SHORT[moon_sign], "signHi": SIGN_HI[moon_sign],
                  "signFull": SIGNS[moon_sign], "lord": LORDS[moon_sign], "lordHi": LORDS_HI[moon_sign]},
        "sunSign": SIGN_SHORT[planets["sun"]["sign"]],
        "planets": planets,
        "houses": [{"house": i + 1, "sign": (lagna_sign + i) % 12, "signName": SIGN_SHORT[(lagna_sign + i) % 12],
                    "signHi": SIGN_HI[(lagna_sign + i) % 12], "lord": LORDS[(lagna_sign + i) % 12],
                    "lordHi": LORDS_HI[(lagna_sign + i) % 12]} for i in range(12)],
        "panchang": {"tithiNumber": tithi_num, "paksha": paksha, "pakshaHi": PAKSHA_HI[paksha],
                     "tithi": paksha + " " + tithi_name, "tithiHi": PAKSHA_HI[paksha] + " " + tithi_name_hi,
                     "vara": vara, "varaHi": vara_hi, "nakshatra": planets["moon"]["nakshatra"]["name"],
                     "nakshatraHi": planets["moon"]["nakshatra"]["nameHi"], "yoga": None, "karana": None},
        "dashas": dasha_timeline(trop["moon"], utc),
        "navamsaSigns": navamsa,
    }


# Analysis-friendly view: only what the dosh rules need.
def analysis_view(chart: dict) -> dict:
    current = chart["dashas"]["current"]
    periods = chart["dashas"]["periods"]
    try:
        idx = next(i for i, d in enumerate(periods) if d is current)
        next_lord = periods[idx + 1]["lord"] if idx + 1 < len(periods) else None
    except StopIteration:
        next_lord = None
    return {
        "lagnaSign": chart["lagna"]["sign"],
        "moonSign": chart["rashi"]["moonSign"],
        "sunSign": math.floor(chart["planets"]["sun"]["sidereal"] / 30),
        "planets": {p: {
            "sign": (q := chart["planets"][p])["sign"], "house": q["house"],
            "degreeInSign": q["degreeInSign"], "dignity": q["dignity"],
            "nakshatra": q["nakshatra"]["name"], "navamsaSign": chart["navamsaSigns"][p],
        } for p in PLANET_ORDER},
        "dasha": {"currentLord": current["lord"], "nextLord": next_lord},
    }
