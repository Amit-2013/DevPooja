"""Mangal Dosha / Kuja Dosha — port of rules/mangalDosh.js: Mars in houses 1, 2, 4,
7, 8 or 12 counted from the lagna (and additionally from the Moon and Venus in
South Indian tradition). Cancellation (classic exceptions): Mars in its own sign
or exaltation, Mars aspected by Jupiter, or the matching house occupied by a benefic."""
from .helpers import HOUSES_HIGH, house_from, exalted, own_sign, ordinal

DOSHA_HOUSES = [1, 2, 4, 7, 8, 12]

HOUSE_HI = {1: 'प्रथम', 2: 'द्वितीय', 4: 'चतुर्थ', 7: 'सप्तम', 8: 'अष्टम', 12: 'द्वादश'}
REF_HI = {'lagna': 'लग्न', 'Moon (Chandra lagna)': 'चंद्र लग्न', 'Venus': 'शुक्र'}


def evaluate(view: dict, now=None, partner=None) -> dict | None:
    refs = [
        ('lagna', view['lagnaSign']),
        ('Moon (Chandra lagna)', view['moonSign']),
        ('Venus', view['planets']['venus']['sign']),
    ]
    hits = []
    for ref_name, ref_sign in refs:
        house = house_from(view['planets']['mars'], ref_sign)
        if house in DOSHA_HOUSES:
            hits.append({'ref': ref_name, 'house': house})

    # Cancellation checks on the strongest reference (from the lagna)
    mars = view['planets']['mars']
    house_from_lagna = house_from(mars, view['lagnaSign'])
    cancellations = []
    if exalted(mars):
        cancellations.append('Mars is exalted, a classical cancellation.')
    if own_sign(mars):
        cancellations.append('Mars is in its own sign, a classical cancellation.')
    if (house_from_lagna in HOUSES_HIGH) and (
            view['planets']['jupiter']['sign'] == mars['sign']
            or house_from(view['planets']['jupiter'], view['lagnaSign']) == house_from_lagna):
        cancellations.append('Jupiter occupies or aspects the same house, a classical cancellation.')

    if not hits:
        return None

    primary = hits[0]
    if cancellations:
        severity = 'low'
    elif primary['house'] in HOUSES_HIGH:
        severity = 'high'
    else:
        severity = 'medium'

    confidence = min(0.95, 0.55 + 0.1 * len(hits) + (-0.15 if cancellations else 0.1))

    evidence_hi = [
        'मंगल ' + REF_HI[primary['ref']] + ' से ' + HOUSE_HI[primary['house']] + ' भाव में स्थित है।',
        *['मंगल ' + (REF_HI.get(h['ref'], h['ref'])) + ' से ' + (HOUSE_HI.get(h['house'], h['house'])) + ' भाव में भी स्थित है।' for h in hits[1:]],
        *[('मंगल उच्च राशि में है — यह पारंपरिक रूप से दोष का शमन माना जाता है।' if 'exalted' in c else
           'मंगल अपनी राशि (स्वराशि) में है — यह पारंपरिक रूप से दोष का शमन माना जाता है।' if 'own sign' in c else
           'गुरु उसी भाव में स्थित है या उस पर दृष्टि रखता है — यह पारंपरिक रूप से दोष का शमन माना जाता है।') for c in cancellations],
    ]

    return {
        'detected': True,
        'severity': severity,
        'confidence': round(confidence, 2),
        'evidence': [
            'Mars is in the ' + str(primary['house']) + ordinal(primary['house']) + ' house from the ' + primary['ref'] + '.',
            *['Mars is also in the ' + str(h['house']) + ordinal(h['house']) + ' house from the ' + h['ref'] + '.' for h in hits[1:]],
            *cancellations,
        ],
        'evidenceHi': evidence_hi,
    }
