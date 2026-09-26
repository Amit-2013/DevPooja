"""Pitru Dosha — port of rules/pitruDosh.js: traditionally read when the Sun, Rahu
or Ketu occupy the 9th house, or when the 9th lord is with Rahu/Ketu. The 9th stands
for ancestors and dharma."""
from .helpers import house_from
from ..kundali_engine import DISPLAY_HI

PLANET_HI = {'sun': 'सूर्य', 'rahu': 'राहु', 'ketu': 'केतु'}
LORDS_BY_SIGN = ['mars', 'venus', 'mercury', 'moon', 'sun', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'saturn', 'jupiter']


def evaluate(view: dict, now=None, partner=None) -> dict | None:
    evidence, evidence_hi = [], []
    strength = 0.0

    for p in ('sun', 'rahu', 'ketu'):
        h = house_from(view['planets'][p], view['lagnaSign'])
        if h == 9:
            evidence.append(p.capitalize() + ' occupies the 9th house of ancestors.')
            evidence_hi.append(PLANET_HI[p] + ' पितरों के नौवें भाव में स्थित है।')
            strength += 1 if p == 'sun' else 0.5

    ninth_sign = (view['lagnaSign'] + 8) % 12
    # find the classical lord of the 9th sign
    lord_name = LORDS_BY_SIGN[ninth_sign]
    lord = view['planets'][lord_name]
    if lord['sign'] == view['planets']['rahu']['sign'] or lord['sign'] == view['planets']['ketu']['sign']:
        evidence.append('The lord of the 9th house (' + lord_name + ') is conjunct a lunar node.')
        evidence_hi.append('नौवें भाव के स्वामी (' + (DISPLAY_HI.get(lord_name, lord_name)) + ') की पात (राहु/केतु) से युति है।')
        strength += 1

    if not evidence:
        return None
    severity = 'high' if strength >= 2 else 'medium' if strength >= 1 else 'low'
    return {
        'detected': True,
        'severity': severity,
        'confidence': min(0.9, 0.5 + 0.15 * strength),
        'evidence': evidence,
        'evidenceHi': evidence_hi,
    }
