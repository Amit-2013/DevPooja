-- 004_seed_added_pujas.sql
-- The catalogue gained dedicated Mangal Dosh Nivaran and Shani Shanti pujas
-- (catalog.json). This migration adds them to databases created before they
-- existed. Fresh databases instead seed them directly from catalog.json, so the
-- inserts only fire when a pre-kundali catalogue is already present (any other
-- puja exists). The condition -> puja rule rows live in server/seed.js.

INSERT OR IGNORE INTO pujas(id,name,hindi,cat,icon,dur,price,deity,ben,kit,pop,tags)
  SELECT 'mangal','Mangal Dosh Nivaran Puja','मंगल दोष निवारण पूजा','Health & Dosha','♂',150,5100,'Mangal (Mars) and Hanuman','Traditional Mangal dosh shanti with Mangal jaap and havan.','k_havan',0,'mangal dosh mars manglik marriage marriage matching kuja'
  WHERE EXISTS(SELECT 1 FROM pujas WHERE id NOT IN ('mangal','shani'));
INSERT OR IGNORE INTO pujas(id,name,hindi,cat,icon,dur,price,deity,ben,kit,pop,tags)
  SELECT 'shani','Shani Shanti Puja','शनि शांति पूजा','Health & Dosha','♄',150,4600,'Shani Dev and Hanuman','Traditional Shani shanti with oil daan, jaap and havan.','k_havan',0,'shani saturn sade sati sadesati dhaiya karma discipline delay'
  WHERE EXISTS(SELECT 1 FROM pujas WHERE id NOT IN ('mangal','shani'));
