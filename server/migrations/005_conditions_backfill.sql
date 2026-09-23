-- 005_conditions_backfill.sql
-- Condition metadata (remedy text) and the customer-facing columns the flow needs
-- on kundali_profiles. The condition -> puja rule rows live in server/seed.js
-- (seedKundaliCatalog) because they reference pujas by id.

-- Remedy text per condition, editable by admins (shown as "Suggested spiritual remedy").
ALTER TABLE kundali_conditions ADD COLUMN remedy TEXT NOT NULL DEFAULT '';
UPDATE kundali_conditions SET remedy='Mangal Dosh Nivaran Puja with Mangal havan, traditionally performed to pacify Mars.' WHERE code='mangal_dosha' AND remedy='';
UPDATE kundali_conditions SET remedy='Kaal Sarp Dosh Nivaran Puja and Rudrabhishek, traditionally performed with Rahu-Ketu shanti.' WHERE code='kaal_sarp' AND remedy='';
UPDATE kundali_conditions SET remedy='Pitru Tarpan and Shraddha seva, traditionally performed for ancestors.' WHERE code='pitru_dosha' AND remedy='';
UPDATE kundali_conditions SET remedy='Grahan Dosha shanti with Navagraha havan and charity traditionally associated with the nodes.' WHERE code='grahan_dosha' AND remedy='';
UPDATE kundali_conditions SET remedy='Guru shanti puja and Vishnu sahasranama path, traditionally performed to pacify Jupiter.' WHERE code='guru_chandal' AND remedy='';
UPDATE kundali_conditions SET remedy='Nadi Dosha is assessed between two charts; Mahamrityunjaya jaap is the traditional practice before marriage matching.' WHERE code='nadi_dosha' AND remedy='';
UPDATE kundali_conditions SET remedy='Shani shanti puja, Hanuman Chalisa path and til-oil daan, traditionally performed on Saturdays.' WHERE code='shani_condition' AND remedy='';
UPDATE kundali_conditions SET remedy='Rahu shanti jaap and Durga saptashati path, traditionally performed to pacify Rahu.' WHERE code='rahu_condition' AND remedy='';
UPDATE kundali_conditions SET remedy='Ketu shanti jaap and Ganesha worship, traditionally performed to pacify Ketu.' WHERE code='ketu_condition' AND remedy='';

-- The legacy shani_dasha condition (002) is superseded by the shani_condition rule
-- (transit Sade Sati + natal Saturn). Keep the row for history, stop evaluating it.
UPDATE kundali_conditions SET active=0 WHERE code='shani_dasha' AND EXISTS(SELECT 1 FROM kundali_conditions WHERE code='shani_condition');

-- Customer-facing fields the flow needs on kundali_profiles (002 created the table
-- with only the basics; these ALTERs are safe on a fresh 002 install).
ALTER TABLE kundali_profiles ADD COLUMN birth_time_accuracy TEXT NOT NULL DEFAULT 'exact';
ALTER TABLE kundali_profiles ADD COLUMN purpose TEXT DEFAULT '';
ALTER TABLE kundali_profiles ADD COLUMN email TEXT DEFAULT '';
ALTER TABLE kundali_profiles ADD COLUMN mobile TEXT DEFAULT '';
ALTER TABLE kundali_profiles ADD COLUMN gotra TEXT DEFAULT '';
ALTER TABLE kundali_profiles ADD COLUMN whatsapp TEXT DEFAULT '';
