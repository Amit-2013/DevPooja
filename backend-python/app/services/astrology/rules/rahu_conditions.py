"""Rahu-related conditions — port of rules/rahuConditions.js: a strong Rahu
influence is traditionally read when Rahu sits in the 3rd, 6th, 10th or 11th (its
"good" houses — traditionally NOT flagged), so this rule only flags the difficult
placements: Rahu in the 1st, 5th, 8th or 9th, or Rahu conjunct the Moon."""
from .helpers import house_from

HOUSE_HI = {1: 'प्रथम', 5: 'पंचम', 8: 'अष्टम', 9: 'नवम'}


def evaluate(view: dict, now=None, partner=None) -> dict | None:
    evidence, evidence_hi = [], []
    strength = 0
    R = view['planets']['rahu']
    h = house_from(R, view['lagnaSign'])
    if h in (1, 5, 8, 9):
        s = ('Rahu occupies the ' + str(h) + 'th house from the lagna.').replace('1th', '1st').replace('2th', '2nd').replace('3th', '3rd')
        evidence.append(s)
        evidence_hi.append('राहु लग्न से ' + HOUSE_HI[h] + ' भाव में स्थित है।')
        strength += 1
    if view['planets']['moon']['sign'] == R['sign']:
        evidence.append('The Moon is conjunct Rahu, a traditionally strong Rahu influence on the mind.')
        evidence_hi.append('चंद्र की राहु से युति है — पारंपरिक रूप से मन पर राहु का प्रबल प्रभाव माना जाता है।')
        strength += 1

    if not evidence:
        return None
    return {
        'detected': True,
        'severity': 'high' if strength >= 2 else 'medium',
        'confidence': min(0.85, 0.55 + 0.15 * strength),
        'evidence': evidence,
        'evidenceHi': evidence_hi,
    }
