"""Nadi Dosha — port of rules/nadiDosh.js. A match-based condition: it needs TWO
charts (typically the bride and groom). It cannot be detected from a single
Kundali, so this rule only evaluates when the caller supplies a partner's moon
sign and nakshatra."""

# The three nadis by nakshatra index (0-based): Adi, Madhya, Antya
NADI_OF_NAK = (
    ['Adi', 'Madhya', 'Antya'] * 9
)

NADI_HI = {'Adi': 'आदि', 'Madhya': 'मध्य', 'Antya': 'अंत्य'}


def evaluate(view: dict, now=None, partner: dict | None = None) -> dict | None:
    # Node parity: no partner (or a partner without a nakshatra index) -> rule does not fire.
    if not partner:
        return None
    self_idx = view.get('moonNakshatraIndex')
    partner_idx = partner.get('moonNakshatraIndex')
    if self_idx is None or partner_idx is None:
        return None
    self_nadi = NADI_OF_NAK[self_idx] if 0 <= self_idx < len(NADI_OF_NAK) else None
    partner_nadi = NADI_OF_NAK[partner_idx] if 0 <= partner_idx < len(NADI_OF_NAK) else None
    if not self_nadi or not partner_nadi:
        return None
    if self_nadi != partner_nadi:
        return {
            'detected': False, 'severity': 'none', 'confidence': 0.9,
            'evidence': ['Nadis differ (' + self_nadi + ' vs ' + partner_nadi + '), which is the favourable combination.'],
            'evidenceHi': ['दोनों की नाड़ी भिन्न है (' + NADI_HI[self_nadi] + ' और ' + NADI_HI[partner_nadi] + ') — यह शुभ संयोग है।'],
        }
    same_sign = view['moonSign'] == partner.get('moonSign')
    return {
        'detected': True,
        'severity': 'medium' if same_sign else 'low',
        'confidence': 0.7,
        'evidence': [
            'Both charts have the ' + self_nadi + ' nadi (same-nadi combination).',
            'The Moon signs are also the same, which strengthens the combination.' if same_sign else 'The Moon signs differ, which traditionally softens the combination.',
        ],
        'evidenceHi': [
            'दोनों कुंडलियों की नाड़ी ' + NADI_HI[self_nadi] + ' है (समान नाड़ी संयोग)।',
            'चंद्र राशियाँ भी समान हैं, जो संयोग को प्रबल करता है।' if same_sign else 'चंद्र राशियाँ भिन्न हैं, जो पारंपरिक रूप से संयोग को शांत करता है।',
        ],
    }
