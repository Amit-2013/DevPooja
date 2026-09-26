"""Shani-related conditions — port of rules/shaniConditions.js: Sade Sati (Saturn
transiting the 12th, 1st and 2nd signs from the natal Moon) and a debilitated or
8th-house Saturn. NOTE: Sade Sati depends on the CURRENT Saturn position, i.e. it
is a transit condition, not a fixed birth-chart one. The rule evaluates it as of
today and says so in the evidence."""
from datetime import datetime, timezone

from .. import ephemeris as E


def evaluate(view: dict, now: datetime | None = None, partner=None) -> dict | None:
    evidence, evidence_hi = [], []
    severity = None
    confidence = 0.0

    # Transit Sade Sati (as of the evaluation date)
    now_dt = now or datetime.now(timezone.utc)
    if now_dt.tzinfo is None:
        now_dt = now_dt.replace(tzinfo=timezone.utc)
    saturn_now = E.positions(now_dt)['saturn']
    saturn_sign = int(saturn_now // 30)
    from_house = ((saturn_sign - view['moonSign'] + 12) % 12) + 1  # house from natal Moon
    if from_house in (12, 1, 2):
        phase = 'first (rising) phase' if from_house == 12 else 'peak phase' if from_house == 1 else 'last (setting) phase'
        phase_hi = 'प्रथम (उदय) चरण' if from_house == 12 else 'शिखर चरण' if from_house == 1 else 'अंतिम (अस्त) चरण'
        where = 'over your natal Moon sign' if from_house == 1 else 'in the sign adjacent to your natal Moon'
        evidence.append('Saturn is currently transiting ' + where + ' — Sade Sati, ' + phase + '. Transit conditions change with time; your pandit can confirm the current period.')
        evidence_hi.append('शनि इस समय आपकी जन्म चंद्र राशि ' + ('पर' if from_house == 1 else 'के आस-पास की राशि में') + ' गोचर कर रहा है — साढ़े साती, ' + phase_hi + '। गोचर समय के साथ बदलता है; वर्तमान काल आपके पंडित जी से पुष्ट करें।')
        severity = 'high' if from_house == 1 else 'medium'
        confidence = 0.85

    # Birth-chart Saturn
    sat = view['planets']['saturn']
    if sat['dignity'] == 'Debilitated':
        evidence.append('Saturn is debilitated in the birth chart.')
        evidence_hi.append('जन्म कुंडली में शनि नीच राशि में है।')
        severity = severity or 'medium'
        confidence = max(confidence, 0.7)
    if sat['house'] == 8:
        evidence.append('Saturn occupies the 8th house in the birth chart.')
        evidence_hi.append('जन्म कुंडली में शनि अष्टम भाव में स्थित है।')
        severity = severity or 'low'
        confidence = max(confidence, 0.6)

    if not evidence:
        return None
    return {'detected': True, 'severity': severity, 'confidence': confidence,
            'evidence': evidence, 'evidenceHi': evidence_hi}
