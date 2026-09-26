"""Kaal Sarp Yoga/Dosha — port of rules/kaalSarpDosh.js: all seven classical planets
hemmed between Rahu and Ketu on one axis. Partial Kaal Sarp (one planet outside the
axis) is traditionally treated as a milder condition. No full/partial detection means
not detected."""
from .. import ephemeris as E
from ..kundali_engine import DISPLAY_HI

PLANETS7 = ['sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn']


def evaluate(view: dict, now=None, partner=None) -> dict | None:
    rahu_sign = view['planets']['rahu']['sign']
    ketu_sign = view['planets']['ketu']['sign']

    def in_arc(sign: int) -> bool:
        # signs strictly between Rahu and Ketu along the short way (Rahu + 1..5)
        d = (sign - rahu_sign + 12) % 12
        return 1 <= d <= 5

    outside = [p for p in PLANETS7 if not in_arc(view['planets'][p]['sign'])]

    if not outside:
        # Full Kaal Sarp: everything inside the Rahu-Ketu axis. Direction decides the name.
        # degrees near the nodes ("fangs") raise severity
        def near_node() -> bool:
            for p in PLANETS7:
                diff = E.norm(view['planets'][p]['sign'] * 30 + view['planets'][p]['degreeInSign'] - rahu_sign * 30)
                deg_from_rahu = min(diff, 360 - diff)
                deg_from_ketu = min(E.norm(180 - diff), 360 - E.norm(180 - diff))
                return_bool = deg_from_rahu < 3 or abs(deg_from_ketu) < 3
                if return_bool:
                    return True
            return False

        near = near_node()
        return {
            'detected': True,
            'severity': 'high' if near else 'medium',
            'confidence': 0.85 if near else 0.7,
            'evidence': [
                'All seven classical planets lie on one side of the Rahu-Ketu axis.',
                'A planet sits within a few degrees of a node, which strengthens the combination.' if near else 'No planet is close to the nodal degrees.',
            ],
            'evidenceHi': [
                'सभी सात ग्रह राहु-केतु अक्ष के एक ही तरफ स्थित हैं।',
                'एक ग्रह पात (नोड) के कुछ अंशों के निकट है, जो इस संयोग को और प्रबल करता है।' if near else 'कोई ग्रह नोड के अंशों के निकट नहीं है।',
            ],
        }

    if len(outside) == 1:
        p = outside[0]
        return {
            'detected': True,
            'severity': 'low',
            'confidence': 0.5,
            'evidence': [
                'All planets except ' + p + ' lie on one side of the Rahu-Ketu axis (partial combination).',
                p + ' outside the axis is a classical softening factor.',
            ],
            'evidenceHi': [
                'सभी ग्रह ' + DISPLAY_HI[p] + ' को छोड़कर राहु-केतु अक्ष के एक तरफ स्थित हैं (आंशिक संयोग)।',
                DISPLAY_HI[p] + ' का अक्ष से बाहर होना पारंपरिक रूप से शमन का कारक माना जाता है।',
            ],
        }

    return None
