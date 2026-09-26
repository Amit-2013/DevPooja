"""Kundali module seed — port of server/seed.js seedKundaliCatalog(): condition ->
puja rules, havan kunds and samagri for the recommended pujas. Runs after
seed_catalog (needs pujas). Idempotent (INSERT OR IGNORE semantics via existence
checks, exactly like Node).

Migration parity: the reference rows that Node applies through server/migrations
002/003/005/006 (havan kunds, samagri items, place index, condition metadata incl.
Hindi + remedy text) are applied here too, so a fresh Python-only database matches
the Node database after its boot migrations + seed."""
import json

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (ConditionPujaRule, HavanKund, KundaliCondition, PlaceIndex,
                     Puja, PujaKund, PujaSamagri, SamagriItem, Setting)


async def seed_kundali(db: AsyncSession) -> None:
    async def has_puja(pid: str) -> bool:
        row = (await db.execute(select(Puja).where(Puja.id == pid))).scalar_one_or_none()
        return row is not None

    # --- reference rows from migration 002 (havan kunds + samagri items) ---------
    for kid, name, material, size, price, descr in [
        ('hk_copper_9', 'Copper Havan Kund, 9 inch', 'copper', 9, 1501, 'Traditional copper kund for griha pravesh and Satyanarayan katha'),
        ('hk_brass_12', 'Brass Havan Kund, 12 inch', 'brass', 12, 2400, 'Sturdy brass kund for larger havans'),
        ('hk_stone_15', 'Stone Havan Kund, 15 inch', 'stone', 15, 3800, 'Temple-style stone kund for extended rituals'),
    ]:
        if not await db.get(HavanKund, kid):
            db.add(HavanKund(id=kid, name=name, material=material, size_in=size,
                             price=price, descr=descr))
    for sid, name, unit, cat in [
        ('si_ghee', 'Pure Cow Ghee', 'ml', 'havan'),
        ('si_camphor', 'Camphor tablets', 'pcs', 'havan'),
        ('si_wood', 'Mango Wood Sticks', 'pcs', 'havan'),
        ('si_sambrani', 'Sambrani cups', 'pcs', 'havan'),
        ('si_til', 'Black Sesame (Til)', 'g', 'havan'),
        ('si_akshat', 'Akshat (Unbroken Rice)', 'g', 'havan'),
    ]:
        if not await db.get(SamagriItem, sid):
            db.add(SamagriItem(id=sid, name=name, unit=unit, category=cat))

    # --- condition metadata (migrations 002/003 + remedy 005 + Hindi 006) --------
    # [code, name, descr, severity, remedy, name_hi, descr_hi, remedy_hi]
    conditions = [
        ('mangal_dosha', 'Mangal Dosha',
         'Mars placement traditionally addressed before marriage', 'high',
         'Mangal Dosh Nivaran Puja with Mangal havan, traditionally performed to pacify Mars.',
         'मंगल दोष',
         'पारंपरिक ज्योतिष में मंगल का लग्न, चंद्र लग्न या शुक्र से चौथे, सातवें, आठवें जैसे भावों में स्थित होना मंगल दोष कहलाता है। यह किसी घटना की भविष्यवाणी नहीं है।',
         'मंगल दोष शांति हेतु मंगल दोष निवारण पूजा और मंगल हवन पारंपरिक उपाय हैं।'),
        ('kaal_sarp', 'Kaal Sarp Dosha',
         'Rahu-Ketu axis traditionally addressed with Rudra worship', 'high',
         'Kaal Sarp Dosh Nivaran Puja and Rudrabhishek, traditionally performed with Rahu-Ketu shanti.',
         'काल सर्प दोष',
         'सभी सात ग्रहों का राहु-केतु अक्ष के एक तरफ स्थित होना पारंपरिक रूप से काल सर्प योग कहलाता है।',
         'काल सर्प दोष निवारण पूजा तथा रुद्राभिषेक पारंपरिक उपाय हैं।'),
        ('shani_dasha', 'Shani Dasha',
         'Saturn period traditionally addressed with Shani remedies', 'medium',
         'Shani shanti puja and Hanuman Chalisa path, traditionally performed on Saturdays.',
         'शनि दशा (विरासत)',
         'यह पुरानी शनि दशा स्थिति है, जिसे अब शनि संबंधी स्थिति नियम (साढ़े साती सहित) द्वारा विस्थापित किया गया है।',
         'शनि शांति पूजा और हनुमान चालीसा पाठ पारंपरिक उपाय हैं।'),
        ('pitru_dosha', 'Pitru Dosha',
         'Ancestral rites traditionally addressed with tarpan and Narayan bali', 'medium',
         'Pitru Tarpan and Shraddha seva, traditionally performed for ancestors.',
         'पितृ दोष',
         'पितरों के नौवें भाव में सूर्य, राहु या केतु की स्थिति, या नौवें भाव के स्वामी का राहु/केतु से युत होना पारंपरिक रूप से पितृ दोष कहलाता है।',
         'पितृ तर्पण और श्राद्ध सेवा पारंपरिक उपाय है।'),
        ('grahan_dosha', 'Grahan Dosha',
         'Eclipse-like combination: Sun or Moon with a lunar node', 'medium',
         'Grahan Dosha shanti with Navagraha havan and charity traditionally associated with the nodes.',
         'ग्रहण दोष',
         'सूर्य या चंद्र का राहु या केतु के साथ एक ही राशि में स्थित होना पारंपरिक रूप से ग्रहण दोष कहलाता है।',
         'नवग्रह शांति हवन और दान पारंपरिक उपाय हैं।'),
        ('guru_chandal', 'Guru Chandal Yoga', 'Jupiter conjunct a lunar node', 'medium',
         'Guru shanti puja and Vishnu sahasranama path, traditionally performed to pacify Jupiter.',
         'गुरु चांडाल योग',
         'गुरु का राहु या केतु के साथ एक ही राशि में स्थित होना पारंपरिक रूप से गुरु चांडाल योग कहलाता है।',
         'गुरु शांति पूजा और विष्णु सहस्रनाम पाठ पारंपरिक उपाय हैं।'),
        ('nadi_dosha', 'Nadi Dosha',
         'Same-nadi combination between two charts (needs partner details)', 'medium',
         'Nadi Dosha is assessed between two charts; Mahamrityunjaya jaap is the traditional practice before marriage matching.',
         'नाड़ी दोष',
         'विवाह मिलान में दोनों कुंडलियों की नाड़ी एक ही होना पारंपरिक रूप से नाड़ी दोष कहलाता है। इसकी जाँच हेतु दो कुंडलियाँ आवश्यक होती हैं।',
         'विवाह से पूर्व महामृत्युंजय जाप पारंपरिक उपाय है।'),
        ('shani_condition', 'Shani Condition',
         'Sade Sati transit or a difficult natal Saturn', 'medium',
         'Shani shanti puja, Hanuman Chalisa path and til-oil daan, traditionally performed on Saturdays.',
         'शनि संबंधी स्थिति',
         'शनि की साढ़े साती (गोचर) या जन्म कुंडली में नीच राशि/अष्टम भाव का शनि पारंपरिक रूप से विशेष ध्यान देने योग्य माना जाता है।',
         'शनि शांति पूजा, हनुमान चालीसा पाठ और तिल-तेल दान पारंपरिक उपाय हैं।'),
        ('rahu_condition', 'Rahu Condition',
         'Traditionally significant Rahu placement', 'medium',
         'Rahu shanti jaap and Durga saptashati path, traditionally performed to pacify Rahu.',
         'राहु संबंधी स्थिति',
         'राहु का लग्न, पंचम, अष्टम या नवम भाव में स्थित होना या चंद्र से युति पारंपरिक रूप से महत्वपूर्ण मानी जाती है।',
         'राहु शांति जाप और दुर्गा सप्तशती पाठ पारंपरिक उपाय हैं।'),
        ('ketu_condition', 'Ketu Condition',
         'Traditionally significant Ketu placement', 'low',
         'Ketu shanti jaap and Ganesha worship, traditionally performed to pacify Ketu.',
         'केतु संबंधी स्थिति',
         'केतु का लग्न, सप्तम या नवम भाव में स्थित होना या चंद्र से युति पारंपरिक रूप से महत्वपूर्ण मानी जाती है।',
         'केतु शांति जाप और गणेश पूजन पारंपरिक उपाय हैं।'),
    ]
    for code, name, descr, severity, remedy, name_hi, descr_hi, remedy_hi in conditions:
        row = await db.get(KundaliCondition, code)
        if not row:
            db.add(KundaliCondition(code=code, name=name, descr=descr, severity=severity,
                                    active=1, remedy=remedy, name_hi=name_hi,
                                    descr_hi=descr_hi, remedy_hi=remedy_hi))
        else:
            # Node parity: re-apply on every boot (backfill UPDATE ... WHERE col='')
            if not row.remedy:
                row.remedy = remedy
            if not row.name_hi:
                row.name_hi = name_hi
            if not row.descr_hi:
                row.descr_hi = descr_hi
            if not row.remedy_hi:
                row.remedy_hi = remedy_hi
    # migration 005: legacy shani_dasha is superseded by shani_condition
    if await db.get(KundaliCondition, 'shani_condition'):
        legacy = await db.get(KundaliCondition, 'shani_dasha')
        if legacy:
            legacy.active = 0

    # --- birth-place index (migration 003 + 006) ---------------------------------
    places = [
        ('Mumbai', 'Maharashtra', 'India', 19.0760, 72.8777, 'Asia/Kolkata', 12442373),
        ('Delhi', 'Delhi', 'India', 28.6139, 77.2090, 'Asia/Kolkata', 16787941),
        ('Bengaluru', 'Karnataka', 'India', 12.9716, 77.5946, 'Asia/Kolkata', 8443675),
        ('Hyderabad', 'Telangana', 'India', 17.3850, 78.4867, 'Asia/Kolkata', 6809970),
        ('Ahmedabad', 'Gujarat', 'India', 23.0225, 72.5714, 'Asia/Kolkata', 5577940),
        ('Chennai', 'Tamil Nadu', 'India', 13.0827, 80.2707, 'Asia/Kolkata', 4646732),
        ('Kolkata', 'West Bengal', 'India', 22.5726, 88.3639, 'Asia/Kolkata', 14850000),
        ('Surat', 'Gujarat', 'India', 21.1702, 72.8311, 'Asia/Kolkata', 4467797),
        ('Pune', 'Maharashtra', 'India', 18.5204, 73.8567, 'Asia/Kolkata', 3124458),
        ('Jaipur', 'Rajasthan', 'India', 26.9124, 75.7873, 'Asia/Kolkata', 3046163),
        ('Lucknow', 'Uttar Pradesh', 'India', 26.8467, 80.9462, 'Asia/Kolkata', 2817105),
        ('Varanasi', 'Uttar Pradesh', 'India', 25.3176, 82.9739, 'Asia/Kolkata', 1198491),
        ('Kanpur', 'Uttar Pradesh', 'India', 26.4499, 80.3319, 'Asia/Kolkata', 2765348),
        ('Nagpur', 'Maharashtra', 'India', 21.1458, 79.0882, 'Asia/Kolkata', 2405665),
        ('Indore', 'Madhya Pradesh', 'India', 22.7196, 75.8577, 'Asia/Kolkata', 1960631),
        ('Bhopal', 'Madhya Pradesh', 'India', 23.2599, 77.4126, 'Asia/Kolkata', 1798218),
        ('Patna', 'Bihar', 'India', 25.5941, 85.1376, 'Asia/Kolkata', 1683200),
        ('Vadodara', 'Gujarat', 'India', 22.3072, 73.1812, 'Asia/Kolkata', 1602351),
        ('Coimbatore', 'Tamil Nadu', 'India', 11.0168, 76.9558, 'Asia/Kolkata', 1061447),
        ('Kochi', 'Kerala', 'India', 9.9312, 76.2673, 'Asia/Kolkata', 2100000),
        ('Ujjain', 'Madhya Pradesh', 'India', 23.1793, 75.7849, 'Asia/Kolkata', 515215),
        ('Nashik', 'Maharashtra', 'India', 19.9975, 73.7898, 'Asia/Kolkata', 1486053),
        ('Tirupati', 'Andhra Pradesh', 'India', 13.6288, 79.4192, 'Asia/Kolkata', 374260),
        ('Trimbakeshwar', 'Maharashtra', 'India', 19.9363, 73.5274, 'Asia/Kolkata', 12345),
        ('Haridwar', 'Uttarakhand', 'India', 29.9457, 78.1642, 'Asia/Kolkata', 228832),
        ('Gurugram', 'Haryana', 'India', 28.4595, 77.0266, 'Asia/Kolkata', 876824),
        ('Noida', 'Uttar Pradesh', 'India', 28.5355, 77.3910, 'Asia/Kolkata', 637272),
        ('London', 'England', 'United Kingdom', 51.5074, -0.1278, 'Europe/London', 8982000),
        ('New York', 'New York', 'United States', 40.7128, -74.0060, 'America/New_York', 8336817),
        ('Dubai', 'Dubai', 'United Arab Emirates', 25.2048, 55.2708, 'Asia/Dubai', 3331400),
        ('Singapore', '', 'Singapore', 1.3521, 103.8198, 'Asia/Singapore', 5685807),
        ('Sydney', 'New South Wales', 'Australia', -33.8688, 151.2093, 'Australia/Sydney', 5312163),
        ('Kathmandu', '', 'Nepal', 27.7172, 85.3240, 'Asia/Kathmandu', 1442271),
    ]
    existing = set((await db.execute(select(PlaceIndex.city, PlaceIndex.country))).all())
    for city, state, country, lat, lon, tz, pop in places:
        if (city, country) in existing:
            continue
        db.add(PlaceIndex(city=city, state=state, country=country, lat=lat, lon=lon,
                          tz=tz, population=pop))

    # --- condition -> puja rules (seed.js seedKundaliCatalog) ---------------------
    # [condition_code, puja_id, weight, priority, reason, reason_hi]
    rules = [
        ('mangal_dosha', 'mangal', 10, 'primary',
         'Mangal Dosh Nivaran Puja is the traditional remedy associated with the Mars combination identified in this chart.',
         'इस कुंडली में पहचानी गई मंगल संबंधी स्थिति का पारंपरिक उपाय मंगल दोष निवारण पूजा है।'),
        ('mangal_dosha', 'vivah', 5, 'secondary',
         'A Mars-focused chart is traditionally matched and addressed before marriage.',
         'मंगल-प्रधान कुंडली को पारंपरिक रूप से विवाह से पूर्व मिलान एवं उपाय किया जाता है।'),
        ('mangal_dosha', 'navgraha', 3, 'optional',
         'Navagraha Shanti is a supplementary practice for planetary peace.',
         'नवग्रह शांति ग्रहों की शांति का पूरक पारंपरिक उपाय है।'),
        ('kaal_sarp', 'kaalsarp', 10, 'primary',
         'Kaal Sarp Dosh Nivaran is the traditional remedy associated with the Rahu-Ketu axis combination.',
         'राहु-केतु अक्ष संबंधी स्थिति का पारंपरिक उपाय काल सर्प दोष निवारण है।'),
        ('kaal_sarp', 'rudra', 6, 'secondary',
         'Rudrabhishek is traditionally performed alongside Kaal Sarp shanti.',
         'काल सर्प शांति के साथ रुद्राभिषेक पारंपरिक रूप से किया जाता है।'),
        ('pitru_dosha', 'pitru', 10, 'primary',
         'Pitru Tarpan and Shraddha is the traditional seva associated with ancestral combinations.',
         'पैतृक संबंधी स्थिति की पारंपरिक सेवा पितृ तर्पण और श्राद्ध है।'),
        ('grahan_dosha', 'navgraha', 8, 'primary',
         'Navagraha Shanti havan is the traditional remedy for an eclipse-like Sun-Moon node combination.',
         'सूर्य/चंद्र-पात (ग्रहण जैसी) युति का पारंपरिक उपाय नवग्रह शांति हवन है।'),
        ('grahan_dosha', 'mrityunjaya', 5, 'secondary',
         'Mahamrityunjaya jaap is traditionally recited for protection alongside Grahan shanti.',
         'ग्रहण शांति के साथ रक्षा हेतु महामृत्युंजय जाप पारंपरिक रूप से किया जाता है।'),
        ('guru_chandal', 'navgraha', 8, 'primary',
         'Navagraha Shanti havan is the traditional remedy associated with a Jupiter-node combination.',
         'गुरु-पात युति से संबंधित पारंपरिक उपाय नवग्रह शांति हवन है।'),
        ('guru_chandal', 'rudra', 5, 'secondary',
         'Rudrabhishek is traditionally performed to pacify Jupiter-related combinations.',
         'गुरु संबंधी स्थितियों की शांति हेतु रुद्राभिषेक पारंपरिक रूप से किया जाता है।'),
        ('shani_condition', 'shani', 10, 'primary',
         'Shani shanti puja is the traditional remedy associated with Saturn conditions and Sade Sati.',
         'शनि स्थितियों और साढ़े साती का पारंपरिक उपाय शनि शांति पूजा है।'),
        ('shani_condition', 'navgraha', 5, 'secondary',
         'Navagraha Shanti is a supplementary practice for Saturn periods.',
         'शनि काल हेतु नवग्रह शांति पूरक पारंपरिक उपाय है।'),
        ('rahu_condition', 'kaalsarp', 7, 'primary',
         'Kaal Sarp Dosh Nivaran includes Rahu shanti in the traditional sequence.',
         'पारंपरिक क्रम में काल सर्प दोष निवारण में राहु शांति सम्मिलित है।'),
        ('rahu_condition', 'durga', 5, 'secondary',
         'Durga Saptashati path is traditionally recited for Rahu pacification.',
         'राहु शांति हेतु दुर्गा सप्तशती पाठ पारंपरिक रूप से किया जाता है।'),
        ('ketu_condition', 'kaalsarp', 7, 'primary',
         'Kaal Sarp Dosh Nivaran includes Ketu shanti in the traditional sequence.',
         'पारंपरिक क्रम में काल सर्प दोष निवारण में केतु शांति सम्मिलित है।'),
        ('ketu_condition', 'ganesh', 5, 'secondary',
         'Ganesha worship is traditionally associated with Ketu pacification.',
         'केतु शांति हेतु गणेश पूजन पारंपरिक रूप से किया जाता है।'),
    ]
    existing_rules = set((await db.execute(
        select(ConditionPujaRule.condition_code, ConditionPujaRule.puja_id))).all())
    for code, puja_id, weight, priority, reason, reason_hi in rules:
        if (code, puja_id) in existing_rules or not await has_puja(puja_id):
            continue
        db.add(ConditionPujaRule(condition_code=code, puja_id=puja_id, weight=weight,
                                 priority=priority, reason=reason, reason_hi=reason_hi))
    # seed.js upgrade rows: migration-002-era rows without priority/reason
    upgrades = [
        ('mangal_dosha', 'mangal', 'primary',
         'Mangal Dosh Nivaran Puja is the traditional remedy associated with the Mars combination identified in this chart.'),
        ('mangal_dosha', 'vivah', 'secondary',
         'A Mars-focused chart is traditionally matched and addressed before marriage.'),
        ('pitru_dosha', 'pitru', 'primary',
         'Pitru Tarpan and Shraddha is the traditional seva associated with ancestral combinations.'),
    ]
    for code, puja_id, priority, reason in upgrades:
        row = (await db.execute(select(ConditionPujaRule).where(
            ConditionPujaRule.condition_code == code,
            ConditionPujaRule.puja_id == puja_id))).scalar_one_or_none()
        if row and (row.reason == '' or row.priority == 'secondary' and priority == 'primary'):
            row.priority = priority
            if not row.reason:
                row.reason = reason

    # --- havan kunds + samagri for the recommended pujas (seed.js) ----------------
    for puja_id, kund_id, rec in [
        ('mangal', 'hk_brass_12', 1), ('kaalsarp', 'hk_stone_15', 1),
        ('shani', 'hk_brass_12', 1), ('navgraha', 'hk_copper_9', 1),
        ('pitru', 'hk_copper_9', 1),
    ]:
        if await has_puja(puja_id):
            row = (await db.execute(select(PujaKund).where(
                PujaKund.puja_id == puja_id, PujaKund.kund_id == kund_id))).scalar_one_or_none()
            if not row:
                db.add(PujaKund(puja_id=puja_id, kund_id=kund_id, recommended=rec))
    for puja_id, item_id, qty in [
        ('navgraha', 'si_ghee', 250), ('navgraha', 'si_camphor', 10),
        ('kaalsarp', 'si_til', 100), ('pitru', 'si_til', 250),
        ('pitru', 'si_akshat', 100), ('mangal', 'si_ghee', 250),
        ('mangal', 'si_wood', 21), ('shani', 'si_til', 250), ('shani', 'si_ghee', 250),
    ]:
        if await has_puja(puja_id):
            row = (await db.execute(select(PujaSamagri).where(
                PujaSamagri.puja_id == puja_id, PujaSamagri.item_id == item_id))).scalar_one_or_none()
            if not row:
                db.add(PujaSamagri(puja_id=puja_id, item_id=item_id, qty=qty))

    # --- kundali_pricing default (kundaliBilling reads the setting) ---------------
    from .services.kundali_billing import DEFAULTS
    row = await db.get(Setting, 'kundali_pricing')
    if not row:
        db.add(Setting(key='kundali_pricing', value=json.dumps(DEFAULTS)))

    await db.flush()
