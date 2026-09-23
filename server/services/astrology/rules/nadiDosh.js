/* Nadi Dosha is a match-based condition: it needs TWO charts (typically the bride
   and groom). It cannot be detected from a single Kundali, so this rule only
   evaluates when the caller supplies a partner's moon sign and nakshatra. */
'use strict';

/* The three nadis by nakshatra index (0-based): Adi, Madhya, Antya */
const NADI_OF_NAK = [
  'Adi', 'Madhya', 'Antya', 'Adi', 'Madhya', 'Antya', 'Adi', 'Madhya', 'Antya',
  'Adi', 'Madhya', 'Antya', 'Adi', 'Madhya', 'Antya', 'Adi', 'Madhya', 'Antya',
  'Adi', 'Madhya', 'Antya', 'Adi', 'Madhya', 'Antya', 'Adi', 'Madhya', 'Antya'
];

function evaluate(view, partner) {
  if (!partner || !partner.moonNakshatraIndex && partner.moonNakshatraIndex !== 0) return null;
  const selfNadi = NADI_OF_NAK[view.moonNakshatraIndex];
  const partnerNadi = NADI_OF_NAK[partner.moonNakshatraIndex];
  if (!selfNadi || !partnerNadi) return null;
  if (selfNadi !== partnerNadi) {
    return {
      detected: false, severity: 'none', confidence: 0.9,
      evidence: ['Nadis differ (' + selfNadi + ' vs ' + partnerNadi + '), which is the favourable combination.']
    };
  }
  const sameSign = view.moonSign === partner.moonSign;
  return {
    detected: true,
    severity: sameSign ? 'medium' : 'low',
    confidence: 0.7,
    evidence: [
      'Both charts have the ' + selfNadi + ' nadi (same-nadi combination).',
      sameSign ? 'The Moon signs are also the same, which strengthens the combination.' : 'The Moon signs differ, which traditionally softens the combination.'
    ]
  };
}

module.exports = { evaluate, NADI_OF_NAK };
