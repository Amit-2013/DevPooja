-- 006_kundali_hindi_place.sql
-- Two additions, both idempotent (guarded ALTERs + guarded UPDATEs):
--   1. kundali_profiles gains state + country so the resolved birth place is stored
--      in full (pob/lat/lon/tz already exist from 003). Existing rows keep working:
--      the new columns default to '' and old kundalis are never rewritten.
--   2. Hindi (Devanagari) columns for the kundali catalog so the whole flow renders
--      bilingually. Hindi survives a demo RESET because replayMigrationSeeds() re-runs
--      every INSERT in the migrations after a wipe, and server/seed.js re-applies the
--      same backfill UPDATEs on every boot.

ALTER TABLE kundali_profiles ADD COLUMN state TEXT NOT NULL DEFAULT '';
ALTER TABLE kundali_profiles ADD COLUMN country TEXT NOT NULL DEFAULT '';

ALTER TABLE kundali_conditions ADD COLUMN name_hi TEXT NOT NULL DEFAULT '';
ALTER TABLE kundali_conditions ADD COLUMN descr_hi TEXT NOT NULL DEFAULT '';
ALTER TABLE kundali_conditions ADD COLUMN remedy_hi TEXT NOT NULL DEFAULT '';

ALTER TABLE dosh_analysis ADD COLUMN evidence_hi TEXT NOT NULL DEFAULT '[]';

ALTER TABLE condition_puja_rules ADD COLUMN reason_hi TEXT NOT NULL DEFAULT '';
ALTER TABLE puja_recommendations ADD COLUMN reason_hi TEXT NOT NULL DEFAULT '';

UPDATE kundali_conditions SET name_hi='मंगल दोष',
  descr_hi='पारंपरिक ज्योतिष में मंगल का लग्न, चंद्र लग्न या शुक्र से चौथे, सातवें, आठवें जैसे भावों में स्थित होना मंगल दोष कहलाता है। यह किसी घटना की भविष्यवाणी नहीं है।',
  remedy_hi='मंगल दोष शांति हेतु मंगल दोष निवारण पूजा और मंगल हवन पारंपरिक उपाय हैं।'
 WHERE code='mangal_dosha' AND name_hi='';
UPDATE kundali_conditions SET name_hi='काल सर्प दोष',
  descr_hi='सभी सात ग्रहों का राहु-केतु अक्ष के एक तरफ स्थित होना पारंपरिक रूप से काल सर्प योग कहलाता है।',
  remedy_hi='काल सर्प दोष निवारण पूजा तथा रुद्राभिषेक पारंपरिक उपाय हैं।'
 WHERE code='kaal_sarp' AND name_hi='';
UPDATE kundali_conditions SET name_hi='पितृ दोष',
  descr_hi='पितरों के नौवें भाव में सूर्य, राहु या केतु की स्थिति, या नौवें भाव के स्वामी का राहु/केतु से युत होना पारंपरिक रूप से पितृ दोष कहलाता है।',
  remedy_hi='पितृ तर्पण और श्राद्ध सेवा पारंपरिक उपाय है।'
 WHERE code='pitru_dosha' AND name_hi='';
UPDATE kundali_conditions SET name_hi='ग्रहण दोष',
  descr_hi='सूर्य या चंद्र का राहु या केतु के साथ एक ही राशि में स्थित होना पारंपरिक रूप से ग्रहण दोष कहलाता है।',
  remedy_hi='नवग्रह शांति हवन और दान पारंपरिक उपाय हैं।'
 WHERE code='grahan_dosha' AND name_hi='';
UPDATE kundali_conditions SET name_hi='गुरु चांडाल योग',
  descr_hi='गुरु का राहु या केतु के साथ एक ही राशि में स्थित होना पारंपरिक रूप से गुरु चांडाल योग कहलाता है।',
  remedy_hi='गुरु शांति पूजा और विष्णु सहस्रनाम पाठ पारंपरिक उपाय हैं।'
 WHERE code='guru_chandal' AND name_hi='';
UPDATE kundali_conditions SET name_hi='नाड़ी दोष',
  descr_hi='विवाह मिलान में दोनों कुंडलियों की नाड़ी एक ही होना पारंपरिक रूप से नाड़ी दोष कहलाता है। इसकी जाँच हेतु दो कुंडलियाँ आवश्यक होती हैं।',
  remedy_hi='विवाह से पूर्व महामृत्युंजय जाप पारंपरिक उपाय है।'
 WHERE code='nadi_dosha' AND name_hi='';
UPDATE kundali_conditions SET name_hi='शनि संबंधी स्थिति',
  descr_hi='शनि की साढ़े साती (गोचर) या जन्म कुंडली में नीच राशि/अष्टम भाव का शनि पारंपरिक रूप से विशेष ध्यान देने योग्य माना जाता है।',
  remedy_hi='शनि शांति पूजा, हनुमान चालीसा पाठ और तिल-तेल दान पारंपरिक उपाय हैं।'
 WHERE code='shani_condition' AND name_hi='';
UPDATE kundali_conditions SET name_hi='राहु संबंधी स्थिति',
  descr_hi='राहु का लग्न, पंचम, अष्टम या नवम भाव में स्थित होना या चंद्र से युति पारंपरिक रूप से महत्वपूर्ण मानी जाती है।',
  remedy_hi='राहु शांति जाप और दुर्गा सप्तशती पाठ पारंपरिक उपाय हैं।'
 WHERE code='rahu_condition' AND name_hi='';
UPDATE kundali_conditions SET name_hi='केतु संबंधी स्थिति',
  descr_hi='केतु का लग्न, सप्तम या नवम भाव में स्थित होना या चंद्र से युति पारंपरिक रूप से महत्वपूर्ण मानी जाती है।',
  remedy_hi='केतु शांति जाप और गणेश पूजन पारंपरिक उपाय हैं।'
 WHERE code='ketu_condition' AND name_hi='';

-- Hindi mapping reasons (English rows already exist from 003/seed; these fill the
-- Hindi text for the same condition -> puja pairs).
UPDATE condition_puja_rules SET reason_hi='इस कुंडली में पहचानी गई मंगल संबंधी स्थिति का पारंपरिक उपाय मंगल दोष निवारण पूजा है।' WHERE condition_code='mangal_dosha' AND puja_id='mangal' AND reason_hi='';
UPDATE condition_puja_rules SET reason_hi='मंगल-प्रधान कुंडली को पारंपरिक रूप से विवाह से पूर्व मिलान एवं उपाय किया जाता है।' WHERE condition_code='mangal_dosha' AND puja_id='vivah' AND reason_hi='';
UPDATE condition_puja_rules SET reason_hi='नवग्रह शांति ग्रहों की शांति का पूरक पारंपरिक उपाय है।' WHERE condition_code='mangal_dosha' AND puja_id='navgraha' AND reason_hi='';
UPDATE condition_puja_rules SET reason_hi='राहु-केतु अक्ष संबंधी स्थिति का पारंपरिक उपाय काल सर्प दोष निवारण है।' WHERE condition_code='kaal_sarp' AND puja_id='kaalsarp' AND reason_hi='';
UPDATE condition_puja_rules SET reason_hi='काल सर्प शांति के साथ रुद्राभिषेक पारंपरिक रूप से किया जाता है।' WHERE condition_code='kaal_sarp' AND puja_id='rudra' AND reason_hi='';
UPDATE condition_puja_rules SET reason_hi='पैतृक संबंधी स्थिति की पारंपरिक सेवा पितृ तर्पण और श्राद्ध है।' WHERE condition_code='pitru_dosha' AND puja_id='pitru' AND reason_hi='';
UPDATE condition_puja_rules SET reason_hi='सूर्य/चंद्र-पात (ग्रहण जैसी) युति का पारंपरिक उपाय नवग्रह शांति हवन है।' WHERE condition_code='grahan_dosha' AND puja_id='navgraha' AND reason_hi='';
UPDATE condition_puja_rules SET reason_hi='ग्रहण शांति के साथ रक्षा हेतु महामृत्युंजय जाप पारंपरिक रूप से किया जाता है।' WHERE condition_code='grahan_dosha' AND puja_id='mrityunjaya' AND reason_hi='';
UPDATE condition_puja_rules SET reason_hi='गुरु-पात युति से संबंधित पारंपरिक उपाय नवग्रह शांति हवन है।' WHERE condition_code='guru_chandal' AND puja_id='navgraha' AND reason_hi='';
UPDATE condition_puja_rules SET reason_hi='गुरु संबंधी स्थितियों की शांति हेतु रुद्राभिषेक पारंपरिक रूप से किया जाता है।' WHERE condition_code='guru_chandal' AND puja_id='rudra' AND reason_hi='';
UPDATE condition_puja_rules SET reason_hi='शनि स्थितियों और साढ़े साती का पारंपरिक उपाय शनि शांति पूजा है।' WHERE condition_code='shani_condition' AND puja_id='shani' AND reason_hi='';
UPDATE condition_puja_rules SET reason_hi='शनि काल हेतु नवग्रह शांति पूरक पारंपरिक उपाय है।' WHERE condition_code='shani_condition' AND puja_id='navgraha' AND reason_hi='';
UPDATE condition_puja_rules SET reason_hi='पारंपरिक क्रम में काल सर्प दोष निवारण में राहु शांति सम्मिलित है।' WHERE condition_code='rahu_condition' AND puja_id='kaalsarp' AND reason_hi='';
UPDATE condition_puja_rules SET reason_hi='राहु शांति हेतु दुर्गा सप्तशती पाठ पारंपरिक रूप से किया जाता है।' WHERE condition_code='rahu_condition' AND puja_id='durga' AND reason_hi='';
UPDATE condition_puja_rules SET reason_hi='पारंपरिक क्रम में काल सर्प दोष निवारण में केतु शांति सम्मिलित है।' WHERE condition_code='ketu_condition' AND puja_id='kaalsarp' AND reason_hi='';
UPDATE condition_puja_rules SET reason_hi='केतु शांति हेतु गणेश पूजन पारंपरिक रूप से किया जाता है।' WHERE condition_code='ketu_condition' AND puja_id='ganesh' AND reason_hi='';

-- Demo birth places for the two new demo customers (idempotent).
INSERT OR IGNORE INTO place_index(city,state,country,lat,lon,tz,population) VALUES
  ('Kolkata','West Bengal','India',22.5726,88.3639,'Asia/Kolkata',14850000),
  ('Kochi','Kerala','India',9.9312,76.2673,'Asia/Kolkata',2100000);
UPDATE kundali_conditions SET name_hi='शनि दशा (विरासत)',
  descr_hi='यह पुरानी शनि दशा स्थिति है, जिसे अब शनि संबंधी स्थिति नियम (साढ़े साती सहित) द्वारा विस्थापित किया गया है।',
  remedy_hi='शनि शांति पूजा और हनुमान चालीसा पाठ पारंपरिक उपाय हैं।'
 WHERE code='shani_dasha' AND name_hi='';
