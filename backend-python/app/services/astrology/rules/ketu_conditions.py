"""Ketu-related conditions — port of rules/ketuConditions.js: traditionally read
when Ketu occupies the 1st, 7th or 9th house, or is conjunct the Moon."""
from .helpers import house_from, ordinal

HOUSE_HI = {1: 'प्रथम', 7: 'सप्तम', 9: 'नवम'}


def evaluate(view: dict, now=None, partner=None) -> dict | None:
    evidence, evidence_hi = [], []
    strength = 0
    K = view['planets']['ketu']
    h = house_from(K, view['lagnaSign'])
    if h in (1, 7, 9):
        evidence.append('Ketu occupies the ' + str(h) + ordinal(h) + ' house from the lagna.')
        evidence_hi.append('केतु लग्न से ' + HOUSE_HI[h] + ' भाव में स्थित है।')
        strength += 1
    if view['planets']['moon']['sign'] == K['sign']:
        evidence.append('The Moon is conjunct Ketu, a traditionally strong Ketu influence on the mind.')
        evidence_hi.append('चंद्र की केतु से युति है — पारंपरिक रूप से मन पर केतु का प्रबल प्रभाव माना जाता है।')
        strength += 1

    if not evidence:
        return None
    return {
        'detected': True,
        'severity': 'high' if strength >= 2 else 'low',
        'confidence': min(0.8, 0.5 + 0.15 * strength),
        'evidence': evidence,
        'evidenceHi': evidence_hi,
    }
