"""Parity port of tests/astro.test.js: ephemeris accuracy anchors (JPL Horizons),
chart builder invariants, dosh rule behaviour, and the Hindi (Devanagari) fields.
Run: .venv/Scripts/python -m pytest tests/astro_parity.py -q"""
import math
from datetime import datetime, timezone

from app.services.astrology import ephemeris as E
from app.services.astrology import kundali_engine as K
from app.services.astrology import rules

SIGNS = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces']


def sign_of(lon: float) -> str:
    return SIGNS[int(E.norm(lon) // 30)]


# Apparent geocentric ecliptic longitudes of date (tropical), fetched from the
# JPL Horizons API (QUANTITIES=31, ObsEcLon column) for these exact instants.
# The engine returns Lahiri-sidereal longitudes; tests convert with the module
# ayanamsa and compare. Tolerances: ~3 arc-minutes (light-time/aberration residuals).
JPL = {
    '2026-01-15T05:00:00Z': {'sun': 295.0451599, 'moon': 254.5833759, 'mars': 293.6417421,
                             'venus': 297.0801953, 'jupiter': 109.4557555, 'saturn': 357.1445642},
    '1990-01-15T05:00:00Z': {'sun': 294.7812593, 'moon': 163.8452708, 'mars': 259.7014597,
                             'venus': 300.8584139, 'jupiter': 93.4003470, 'saturn': 287.2800969},
}
TOL = {'sun': 0.02, 'moon': 0.05, 'mars': 0.05, 'venus': 0.05, 'jupiter': 0.1, 'saturn': 0.1}


def _utc(s: str) -> datetime:
    return datetime.strptime(s, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)


for when, expected in JPL.items():
    def make_test(when=when, expected=expected):
        def test_jpl():
            d = _utc(when)
            p = E.positions(d)
            ayan = E.ayanamsa(E.julian_day(d))
            for body, jpl in expected.items():
                tropical = E.norm(p[body] + ayan)
                diff = abs(E.norm(tropical - jpl + 180) - 180)
                assert diff < TOL[body], f'{body} {tropical:.4f} vs JPL {jpl} (diff {diff:.4f})'
        test_jpl.__name__ = f'test_ephemeris_matches_jpl_horizons_{when}'
        return test_jpl
    globals()[f'test_ephemeris_matches_jpl_horizons_{when}'] = make_test()


def test_nodes_are_opposite_each_other():
    p = E.positions(_utc('2010-11-15T12:00:00Z'))
    assert E.norm(p['rahu'] + 180 - p['ketu']) < 1e-6


def test_ascendant_matches_published_sidereal_charts():
    # M.K. Gandhi, 1869-10-02 ~02:33 UT Porbandar: classical charts give Libra lagna ~3-5 deg
    gandhi = E.ascendant(_utc('1869-10-02T02:33:00Z'), 21.64, 69.6)
    assert sign_of(gandhi) == 'Libra'
    # Albert Einstein, 1879-03-14 10:50 UT Ulm: published sidereal lagna Gemini ~17-20 deg
    einstein = E.ascendant(_utc('1879-03-14T10:50:00Z'), 48.4, 10.0)
    assert sign_of(einstein) == 'Gemini'


def test_chart_builder_lagna_rashi_nakshatra_dasha_invariants():
    c = K.build_chart({'name': 'Test', 'gender': '', 'dob': '1990-01-15', 'tob': '10:30',
                       'birthTimeAccuracy': 'exact', 'lat': 28.6139, 'lon': 77.2090,
                       'tz': 'Asia/Kolkata', 'place': 'Delhi'})
    assert c['lagna']['signName'] == 'Pisces'
    assert c['rashi']['signName'] == 'Leo'
    assert c['panchang']['nakshatra'] == 'Purva Phalguni'
    # Purva Phalguni is Venus-ruled: the first mahadasha must be Venus
    assert c['dashas']['periods'][0]['lord'] == 'Venus'
    # dasha periods must be contiguous and follow the Vimshottari order
    order = ['Venus', 'Sun', 'Moon', 'Mars', 'Rahu', 'Jupiter', 'Saturn', 'Mercury', 'Ketu']
    seq = [d['lord'] for d in c['dashas']['periods'][:9]]
    i = order.index(seq[0])
    for idx, lord in enumerate(seq):
        assert lord == order[(i + idx) % 9], 'dasha order'
    # every planet has house 1..12 and a nakshatra
    for p in c['planets'].values():
        assert 1 <= p['house'] <= 12
        assert 1 <= p['nakshatra']['pada'] <= 4
    # lagna house 1 contains planets whose sign equals the lagna sign
    for p in c['planets'].values():
        if p['sign'] == c['lagna']['sign']:
            assert p['house'] == 1


def test_chart_works_without_birth_time():
    c = K.build_chart({'name': 'No Time', 'gender': '', 'dob': '2000-06-15', 'tob': '',
                       'birthTimeAccuracy': 'unknown', 'lat': 19.076, 'lon': 72.8777,
                       'tz': 'Asia/Kolkata', 'place': 'Mumbai'})
    assert c['meta']['tob'] in ('Unknown', '')
    assert c['planets'] and c['planets']['sun']
    with_time = K.build_chart({'name': 'With Time', 'gender': '', 'dob': '2000-06-15', 'tob': '03:00',
                               'birthTimeAccuracy': 'exact', 'lat': 19.076, 'lon': 72.8777,
                               'tz': 'Asia/Kolkata', 'place': 'Mumbai'})
    # moon moves ~0.5 deg/hour: 9h shift must move it about 4-5 deg, but never change the Sun's sign here
    assert with_time['planets']['sun']['signName'] == c['planets']['sun']['signName']


def test_mangal_dosha_detects_7th_house_mars_and_cancels_on_own_sign():
    def view(mars_sign, mars_dignity):
        return {
            'lagnaSign': 0, 'moonSign': 0,
            'planets': {
                'mars': {'sign': mars_sign, 'house': (mars_sign % 12) + 1, 'degreeInSign': 10, 'dignity': mars_dignity},
                'venus': {'sign': 5, 'house': 6, 'degreeInSign': 1, 'dignity': 'Neutral'},
                'jupiter': {'sign': 8, 'house': 9, 'degreeInSign': 1, 'dignity': 'Neutral'},
                'sun': {'sign': 2, 'house': 3, 'degreeInSign': 1, 'dignity': 'Neutral'},
                'moon': {'sign': 0, 'house': 1, 'degreeInSign': 1, 'dignity': 'Neutral'},
                'mercury': {'sign': 2, 'house': 3, 'degreeInSign': 1, 'dignity': 'Neutral'},
                'saturn': {'sign': 9, 'house': 10, 'degreeInSign': 1, 'dignity': 'Neutral'},
                'rahu': {'sign': 3, 'house': 4, 'degreeInSign': 1, 'dignity': 'Neutral'},
                'ketu': {'sign': 9, 'house': 10, 'degreeInSign': 1, 'dignity': 'Neutral'},
            },
        }
    detected = rules.get('mangal_dosha').evaluate(view(6, 'Neutral'))  # Mars in Libra = 7th from Aries lagna
    assert detected and detected['detected'] and detected['severity'] == 'high'
    own = rules.get('mangal_dosha').evaluate(view(0, 'Own sign'))  # Mars in Aries = 1st house, own sign
    assert own and own['detected'] and own['severity'] == 'low', 'own-sign Mars should soften to low'
    # Mars in Virgo: 6th from lagna (clean) but 1st from Venus — move Venus away too
    far = view(5, 'Neutral')
    far['planets']['venus']['sign'] = 7
    assert rules.get('mangal_dosha').evaluate(far) is None


def test_grahan_dosha_sun_with_node_within_5_degrees_is_high():
    view = {
        'lagnaSign': 0, 'moonSign': 0,
        'planets': {
            'sun': {'sign': 4, 'house': 5, 'degreeInSign': 12.0, 'dignity': 'Neutral'},
            'moon': {'sign': 0, 'house': 1, 'degreeInSign': 15.0, 'dignity': 'Neutral'},
            'rahu': {'sign': 4, 'house': 5, 'degreeInSign': 16.0, 'dignity': 'Neutral'},
            'ketu': {'sign': 10, 'house': 11, 'degreeInSign': 16.0, 'dignity': 'Neutral'},
            'mars': {'sign': 2, 'house': 3, 'degreeInSign': 1, 'dignity': 'Neutral'},
            'mercury': {'sign': 4, 'house': 5, 'degreeInSign': 20, 'dignity': 'Neutral'},
            'jupiter': {'sign': 8, 'house': 9, 'degreeInSign': 1, 'dignity': 'Neutral'},
            'venus': {'sign': 5, 'house': 6, 'degreeInSign': 1, 'dignity': 'Neutral'},
            'saturn': {'sign': 9, 'house': 10, 'degreeInSign': 1, 'dignity': 'Neutral'},
        },
    }
    out = rules.get('grahan_dosha').evaluate(view)
    assert out and out['detected'] and out['severity'] == 'high'
    assert 'Sun' in out['evidence'][0]


def test_nadi_dosha_same_nadi_detected_different_not():
    base = {'moonSign': 3, 'moonNakshatraIndex': 6}
    same = rules.get('nadi_dosha').evaluate(base, partner={'moonSign': 3, 'moonNakshatraIndex': 9})  # both Adi
    assert same and same['detected']
    diff = rules.get('nadi_dosha').evaluate(base, partner={'moonSign': 5, 'moonNakshatraIndex': 10})  # Madhya vs Adi
    assert diff and not diff['detected']
    assert rules.get('nadi_dosha').evaluate(base) is None, 'no partner: rule does not fire'


# ---- Hindi (Devanagari) fields: additive, English always intact ------------------
def test_hindi_engine_fields_signs_nakshatras_planets_dignity_panchang_dasha():
    # all 12 rashis, English alongside Hindi
    assert len(K.SIGN_HI) == 12
    assert K.SIGN_HI[0] == 'मेष'
    assert K.SIGN_HI[11] == 'मीन'
    assert K.SIGN_SHORT[0] == 'Aries'
    # all 27 nakshatras in Hindi
    assert len(K.NAKSHATRAS_HI) == 27
    assert K.NAKSHATRAS_HI[0] == 'अश्विनी'
    assert K.NAKSHATRAS_HI[26] == 'रेवती'
    assert len(K.NAKSHATRAS) == 27
    # planet names
    assert K.DISPLAY_HI['sun'] == 'सूर्य'
    assert K.DISPLAY_HI['moon'] == 'चंद्र'
    assert K.DISPLAY_HI['mars'] == 'मंगल'
    assert K.DISPLAY_HI['mercury'] == 'बुध'
    assert K.DISPLAY_HI['jupiter'] == 'गुरु'
    assert K.DISPLAY_HI['venus'] == 'शुक्र'
    assert K.DISPLAY_HI['saturn'] == 'शनि'
    assert K.DISPLAY_HI['rahu'] == 'राहु'
    assert K.DISPLAY_HI['ketu'] == 'केतु'

    c = K.build_chart({'name': 'Hindi Tester', 'gender': '', 'dob': '1990-01-15', 'tob': '10:30',
                       'birthTimeAccuracy': 'exact', 'lat': 28.6139, 'lon': 77.209,
                       'tz': 'Asia/Kolkata', 'place': 'Delhi', 'city': 'Delhi',
                       'state': 'Delhi', 'country': 'India'})
    # English fields remain available next to the Hindi ones
    assert c['lagna']['signName'] == 'Pisces'
    assert c['lagna']['signHi'] == 'मीन'
    assert c['rashi']['signName'] == 'Leo'
    assert c['rashi']['signHi'] == 'सिंह'
    # sign + signHi and name + nameHi work on every planet row
    for p in c['planets'].values():
        assert p['signName'] and p['signHi'], 'planet has signName and signHi'
        assert p['nakshatra']['name'] in K.NAKSHATRAS, 'English nakshatra'
        assert p['nakshatra']['nameHi'] in K.NAKSHATRAS_HI, 'Hindi nakshatra'
        assert p['dignityHi'] in ('उच्च', 'नीच', 'स्वराशि', 'मध्यम'), 'Hindi dignity: ' + str(p['dignityHi'])
        assert p['dignity'], 'English dignity kept'
    # panchang is translated
    assert 'पक्ष' in c['panchang']['tithiHi']
    assert c['panchang']['varaHi'] in ('रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार')
    # dasha lords carry Hindi
    for d in c['dashas']['periods']:
        assert d['lordHi'] and d['lord'] != d['lordHi']
    # place details ride on meta
    assert c['meta']['city'] == 'Delhi'
    assert c['meta']['state'] == 'Delhi'
    assert c['meta']['country'] == 'India'


def test_dosh_rules_emit_hindi_evidence_describing_the_condition():
    view = {
        'lagnaSign': 0, 'moonSign': 0,
        'planets': {
            'sun': {'sign': 2, 'house': 3, 'degreeInSign': 12.0, 'dignity': 'Neutral'},
            'moon': {'sign': 3, 'house': 4, 'degreeInSign': 15.0, 'dignity': 'Neutral'},
            'rahu': {'sign': 2, 'house': 3, 'degreeInSign': 16.0, 'dignity': 'Neutral'},
            'ketu': {'sign': 8, 'house': 9, 'degreeInSign': 16.0, 'dignity': 'Neutral'},
            'mars': {'sign': 6, 'house': 7, 'degreeInSign': 10, 'dignity': 'Neutral'},
            'mercury': {'sign': 4, 'house': 5, 'degreeInSign': 20, 'dignity': 'Neutral'},
            'jupiter': {'sign': 6, 'house': 7, 'degreeInSign': 1, 'dignity': 'Neutral'},
            'venus': {'sign': 5, 'house': 6, 'degreeInSign': 1, 'dignity': 'Neutral'},
            'saturn': {'sign': 7, 'house': 8, 'degreeInSign': 1, 'dignity': 'Neutral'},
        },
    }
    mg = rules.get('mangal_dosha').evaluate(view)
    assert mg['detected'] and any('मंगल' in e and 'सप्तम' in e for e in mg['evidenceHi'])
    gr = rules.get('grahan_dosha').evaluate(view)
    assert gr['detected'] and gr['evidenceHi'] and any(
        any('\u0900' <= ch <= '\u097f' for ch in e) for e in gr['evidenceHi']), 'Devanagari evidence'
    ks = rules.get('kaal_sarp').evaluate(view)
    assert ks['detected'] and any('राहु-केतु' in e for e in ks['evidenceHi'])
    # English evidence is still present side by side
    assert 'Mars' in mg['evidence'][0]
    assert 'Sun' in gr['evidence'][0]
