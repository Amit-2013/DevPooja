-- 007_puja_management.sql
-- Puja management additions, idempotent (guarded ALTERs / CREATE IF NOT EXISTS /
-- guarded UPDATEs):
--   1. Customized Puja requests: customers describe the puja they want; admins
--      work the request (Contacted / Quoted) and can convert it into a real
--      catalogue puja. Status: New -> Contacted -> Quoted -> Booked | Closed.
--   2. Hindi benefits (pujas.ben_hi) so the catalogue presents bilingually;
--      backfilled here and re-applied by server/seed.js so RESET keeps Hindi.

CREATE TABLE IF NOT EXISTS custom_requests(
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  name TEXT NOT NULL,
  mobile TEXT NOT NULL,
  purpose TEXT DEFAULT '',
  deity TEXT DEFAULT '',
  preferred_date TEXT DEFAULT '',
  city TEXT DEFAULT '',
  budget INTEGER,
  notes TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New','Contacted','Quoted','Booked','Closed')),
  admin_note TEXT DEFAULT '',
  puja_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

ALTER TABLE pujas ADD COLUMN ben_hi TEXT NOT NULL DEFAULT '';

-- Hindi benefits for the seeded catalogue (matched by name so converted/admin pujas
-- are untouched). server/seed.js re-applies these on every boot for RESET-safety.
UPDATE pujas SET ben_hi='समृद्धि और सुख-शांति हेतु लक्ष्मी जी की पारंपरिक पूजा, विधि-विधान के साथ।' WHERE name='Lakshmi Puja' AND ben_hi='';
UPDATE pujas SET ben_hi='सत्यनारायण भगवान की कथा और पूजा — समृद्धि, संतान और सुख के लिए पारंपरिक सेवा।' WHERE name='Satyanarayan Katha' AND ben_hi='';
UPDATE pujas SET ben_hi='नए घर, दुकान या ऑफिस में प्रवेश से पूर्व शुभ गृह प्रवेश पूजा।' WHERE name='Griha Pravesh' AND ben_hi='';
UPDATE pujas SET ben_hi='गणेश जी की पूजा से हर शुभ कार्य का शुभारंभ, विघ्नों का निवारण।' WHERE name='Ganesh Puja' AND ben_hi='';
UPDATE pujas SET ben_hi='शिव जी का पारंपरिक रुद्राभिषेक — स्वास्थ्य, मन की शांति और ग्रह शांति हेतु।' WHERE name='Rudrabhishek' AND ben_hi='';
UPDATE pujas SET ben_hi='नवग्रह शांति हवन — सभी ग्रहों की अनुकूलता और कुंडली की शांति हेतु।' WHERE name='Navgraha Shanti' AND ben_hi='';
UPDATE pujas SET ben_hi='काल सर्प दोष निवारण पूजा, राहु-केतु शांति के साथ पारंपरिक विधि से।' WHERE name='Kaal Sarp Dosh Nivaran' AND ben_hi='';
UPDATE pujas SET ben_hi='पितरों की संतुष्टि हेतु तर्पण और श्राद्ध सेवा, पारंपरिक विधि से।' WHERE name='Pitru Tarpan and Shraddha' AND ben_hi='';
UPDATE pujas SET ben_hi='हनुमान जी की पूजा और सुंदरकांड पाठ — साहस, सुरक्षा और संकट निवारण हेतु।' WHERE name='Hanuman Puja' AND ben_hi='';
UPDATE pujas SET ben_hi='महामृत्युंजय जाप — आयु और स्वास्थ्य हेतु पारंपरिक रक्षा कवच।' WHERE name='Maha Mrityunjaya Jaap' AND ben_hi='';
UPDATE pujas SET ben_hi='विवाह हेतु शुभ मुहूर्त पूजा — दांपत्य सुख और ग्रह मिलान के उपाय।' WHERE name='Vivah Sanskar' AND ben_hi='';
UPDATE pujas SET ben_hi='व्यापार वृद्धि हेतु पूजा — दुकान या ऑफिस की समृद्धि के लिए।' WHERE name='Shop or Office Opening Puja' AND ben_hi='';
UPDATE pujas SET ben_hi='माँ दुर्गा की पूजा — शक्ति, सुरक्षा और शत्रु निवारण हेतु।' WHERE name='Durga Saptashati Path' AND ben_hi='';
UPDATE pujas SET ben_hi='हनुमान चालीसा और सुंदरकांड पाठ — साहस, सुरक्षा और संकट निवारण हेतु।' WHERE name='Sundarkand Path' AND ben_hi='';
UPDATE pujas SET ben_hi='नामकरण संस्कार — नवजात शिशु का शुभ नामकरण, पारंपरिक विधि से।' WHERE name='Namkaran Sanskar' AND ben_hi='';
UPDATE pujas SET ben_hi='सरस्वती पूजा — विद्या, कला और संगीत की प्रगति हेतु।' WHERE name='Saraswati Puja' AND ben_hi='';
UPDATE pujas SET ben_hi='वास्तु शांति पूजा — निर्माण के दोषों की पारंपरिक शांति हेतु।' WHERE name='Vastu Shanti' AND ben_hi='';
UPDATE pujas SET ben_hi='शनि शांति पूजा — साढ़े साती और शनि दशा के उपाय हेतु, शनिवार विशेष।' WHERE name='Shani Shanti Puja' AND ben_hi='';
UPDATE pujas SET ben_hi='पारंपरिक मंगल दोष निवारण पूजा — मंगल हवन सहित, विवाह मिलान हेतु उपयोगी।' WHERE name='Mangal Dosh Nivaran Puja' AND ben_hi='';
