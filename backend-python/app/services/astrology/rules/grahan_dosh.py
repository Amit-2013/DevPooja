"""Grahan Dosha — port of rules/grahanDosh.js: traditionally read when the Sun or
Moon is conjunct Rahu or Ketu (an eclipse-like combination in the birth chart)."""
from ..kundali_engine import DISPLAY_HI

NODE_HI = {'rahu': 'राहु', 'ketu': 'केतु'}


def evaluate(view: dict, now=None, partner=None) -> dict | None:
    hits = []
    for lum in ('sun', 'moon'):
        L = view['planets'][lum]
        for node in ('rahu', 'ketu'):
            N = view['planets'][node]
            if L['sign'] == N['sign']:
                sep = abs(L['degreeInSign'] - N['degreeInSign'])
                hits.append({'luminary': lum, 'node': node, 'separation': round(sep, 1)})
    if not hits:
        return None
    min_sep = min(h['separation'] for h in hits)
    return {
        'detected': True,
        'severity': 'high' if min_sep < 5 else 'medium' if min_sep < 12 else 'low',
        'confidence': max(0.5, 0.9 - min_sep / 25),
        'evidence': [
            h['luminary'].capitalize() + ' is in the same sign as ' + h['node'] + ' (about ' + str(h['separation']) + '° apart).'
            for h in hits
        ],
        'evidenceHi': [
            DISPLAY_HI[h['luminary']] + ' ' + NODE_HI[h['node']] + ' के साथ एक ही राशि में है (लगभग ' + str(h['separation']) + '° की दूरी पर)।'
            for h in hits
        ],
    }
