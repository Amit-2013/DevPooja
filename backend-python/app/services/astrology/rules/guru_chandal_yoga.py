"""Guru Chandal Yoga — port of rules/guruChandalYoga.js: traditionally read when
Jupiter is conjunct Rahu or Ketu."""
from ..kundali_engine import DISPLAY_HI

NODE_HI = {'rahu': 'राहु', 'ketu': 'केतु'}


def evaluate(view: dict, now=None, partner=None) -> dict | None:
    J = view['planets']['jupiter']
    hit = [{'node': n, 'separation': round(abs(J['degreeInSign'] - view['planets'][n]['degreeInSign']), 1)}
           for n in ('rahu', 'ketu') if view['planets'][n]['sign'] == J['sign']]
    if not hit:
        return None
    min_sep = min(h['separation'] for h in hit)
    return {
        'detected': True,
        'severity': 'high' if min_sep < 5 else 'medium' if min_sep < 12 else 'low',
        'confidence': max(0.5, 0.85 - min_sep / 30),
        'evidence': ['Jupiter is in the same sign as ' + h['node'] + ' (about ' + str(h['separation']) + '° apart).' for h in hit],
        'evidenceHi': ['गुरु ' + NODE_HI[h['node']] + ' के साथ एक ही राशि में है (लगभग ' + str(h['separation']) + '° की दूरी पर)।' for h in hit],
    }
