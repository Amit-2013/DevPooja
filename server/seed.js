require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db, tx, setSetting } = require('./db');
const { addDays, today, j, rid } = require('./lib/util');
const catalog = require('./data/catalog.json');

const isProd = () => process.env.NODE_ENV === 'production';
const demoOn = () => String(process.env.DEMO_MODE || (isProd() ? 'false' : 'true')) === 'true';

function seedCatalog() {
  if (db.prepare('SELECT COUNT(*) c FROM pujas').get().c) return;
  tx(() => {
    const stock = { k_basic: 60, k_lakshmi: 14, k_satya: 35, k_griha: 9, k_shiv: 28, k_havan: 40, k_nav: 22, k_pitru: 31, k_ganesh: 25 };
    catalog.kits.forEach((k) => db.prepare('INSERT INTO kits(id,name,price,icon,items,stock) VALUES(?,?,?,?,?,?)').run(k.id, k.name, k.price, k.icon, JSON.stringify(k.items), stock[k.id] || 20));
    catalog.pujas.forEach((p) => db.prepare('INSERT INTO pujas(id,name,hindi,cat,icon,dur,price,deity,ben,kit,pop,tags) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(p.id, p.name, p.hindi, p.cat, p.icon, p.dur, p.price, p.deity, p.ben, p.kit, p.pop, p.tags));
    catalog.prasad.forEach((k) => db.prepare('INSERT INTO prasad(id,name,price,icon,descr) VALUES(?,?,?,?,?)').run(k.id, k.name, k.price, k.icon, k.descr));
    catalog.temples.forEach((t) => db.prepare('INSERT INTO temples(id,name,city,deity,icon,pujas,offering,descr) VALUES(?,?,?,?,?,?,?,?)').run(t.id, t.name, t.city, t.deity, t.icon, JSON.stringify(t.pujas), t.offering, t.descr));
    catalog.festivals.forEach((f) => db.prepare('INSERT INTO festivals(id,name,date,pujas,note) VALUES(?,?,?,?,?)').run(f.id, f.name, f.date, JSON.stringify(f.pujas), f.note));
    setSetting('commission', 20);
    [['DAIVIKPOOJA10', 'pct', 10, 500, 1500], ['FIRST100', 'flat', 100, 100, 1000], ['FESTIVE15', 'pct', 15, 750, 3000]].forEach((c) => db.prepare('INSERT INTO coupons(code,type,val,max,min,active,used) VALUES(?,?,?,?,?,1,0)').run(...c));
    db.prepare('INSERT INTO banners(id,text,enabled) VALUES(?,?,1)').run('b1', 'Diwali Lakshmi Puja: book early');
  })();
}

function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || (isProd() ? '' : 'admin@daivikpuja.in')).toLowerCase();
  const pass = process.env.ADMIN_PASSWORD || (isProd() ? '' : 'admin123');
  if (!email || !pass) { console.warn('[seed] No admin account created. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env'); return; }
  const hash = bcrypt.hashSync(pass, 10);
  /* An existing admin keeps its account and just gets the new password. The id is only
     fixed for a fresh database: reusing 'admin1' for a different email would collide
     with the admin already in an existing database and crash every boot. */
  const anyAdmin = db.prepare("SELECT id, email FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get();
  const ex = db.prepare("SELECT id FROM users WHERE role='admin' AND email=?").get(email);
  if (ex) db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hash, ex.id);
  else if (anyAdmin) db.prepare('UPDATE users SET email=?, pass_hash=? WHERE id=?').run(email, hash, anyAdmin.id);
  else db.prepare("INSERT INTO users(id,role,name,email,pass_hash,joined,created_at) VALUES(?,?,?,?,?,?,?)").run('admin1', 'admin', 'Administrator', email, hash, today(), Date.now());
}

const DEMO_PASSWORD = 'demo1234';
function seedDemo() {
  if (db.prepare("SELECT COUNT(*) c FROM users WHERE role='customer'").get().c) return;
  const svc = require('./services/bookings');
  const insU = db.prepare("INSERT INTO users(id,role,name,mobile,email,pass_hash,pts,plus,pref,addr,fam,joined,created_at) VALUES(?,'customer',?,?,?,?,?,?,?,?,?,?,?)");
  const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  const U = [
    ['u1', 'Aarav Mehta', '9876543210', 'aarav@example.com', 240, 0, { deity: 'Lakshmi', lang: 'Hindi', wa: true, sms: true, em: true }, [{ id: 'a1', l: 'Home', line: 'B-204, Green Park Residency', city: 'Delhi NCR', pin: '110016' }], [{ id: 'f1', n: 'Kavita Mehta', rel: 'Mother', gotra: 'Kashyap' }, { id: 'f2', n: 'Riya Mehta', rel: 'Spouse', gotra: '' }], -160],
    ['u2', 'Priya Nair', '9811100002', 'priya@example.com', 90, 1, { deity: 'Ganesha', lang: 'English', wa: true, sms: false, em: true }, [{ id: 'a2', l: 'Home', line: '12 Lake View Road', city: 'Bengaluru', pin: '560008' }], [], -120],
    ['u3', 'Karan Desai', '9811100003', 'karan@example.com', 0, 0, { deity: 'Shiva', lang: 'Hindi', wa: true, sms: true, em: false }, [{ id: 'a3', l: 'Home', line: '44 Marine Drive Apartments', city: 'Mumbai', pin: '400020' }], [], -70],
    ['u4', 'Meera Iyer', '9811100004', 'meera@example.com', 410, 1, { deity: 'Lakshmi', lang: 'Tamil', wa: true, sms: true, em: true }, [{ id: 'a4', l: 'Home', line: '8 Temple Street, Mylapore', city: 'Chennai', pin: '600004' }], [], -200],
    ['u5', 'Vikram Singh', '9811100005', 'vikram@example.com', 30, 0, { deity: 'Hanuman', lang: 'Hindi', wa: true, sms: true, em: false }, [{ id: 'a5', l: 'Home', line: '21 Civil Lines', city: 'Jaipur', pin: '302006' }], [], -40],
    ['u6', 'Sunita Rao', '9811100006', 'sunita@example.com', 120, 0, { deity: 'Ganesha', lang: 'English', wa: true, sms: true, em: true }, [{ id: 'a6', l: 'Home', line: '7 Rose Villa', city: 'Hyderabad', pin: '500081' }], [], -55],
    ['u7', 'Rahul Sharma', '9811100007', 'rahul@example.com', 60, 0, { deity: 'Shiva', lang: 'Hindi', wa: true, sms: false, em: true }, [{ id: 'a7', l: 'Home', line: '321 Sector 18', city: 'Noida', pin: '201301' }], [], -25],
    ['u8', 'Anjali Patel', '9811100008', 'anjali@example.com', 310, 1, { deity: 'Lakshmi', lang: 'Gujarati', wa: true, sms: true, em: true }, [{ id: 'a8', l: 'Home', line: '56 Satellite Road', city: 'Ahmedabad', pin: '380015' }], [], -90],
    ['u9', 'Neha Gupta', '9811100009', 'neha@example.com', 75, 0, { deity: 'Durga', lang: 'Hindi', wa: true, sms: true, em: false }, [{ id: 'a9', l: 'Home', line: '14 Ballygunge Circular Road', city: 'Kolkata', pin: '700019' }], [{ id: 'f3', n: 'Rohit Gupta', rel: 'Spouse', gotra: 'Bharadwaj' }], -60],
    ['u10', 'Arjun Menon', '9811100010', 'arjun@example.com', 55, 0, { deity: 'Ganesha', lang: 'English', wa: true, sms: false, em: true }, [{ id: 'a10', l: 'Home', line: '3 Marine Drive, Fort Kochi', city: 'Kochi', pin: '682001' }], [], -35]
  ];
  U.forEach((u) => insU.run(u[0], u[1], u[2], u[3], hash, u[4], u[5], JSON.stringify(u[6]), JSON.stringify(u[7]), JSON.stringify(u[8]), addDays(u[9]), Date.now()));

  const P = [
    ['p1', 'Pt. Ramesh Sharma', 'Delhi NCR', 18, ['Hindi', 'Sanskrit'], ['lakshmi', 'griha', 'satyanarayan', 'vastu', 'vyapar'], 4.9, 412, 1260, 1.15, 'Trained in Varanasi. Known for clear explanations of each ritual step in Hindi.', '#0c4b49', 'verified', 1],
    ['p2', 'Acharya Suresh Iyer', 'Chennai', 24, ['Tamil', 'Sanskrit', 'English'], ['rudra', 'navgraha', 'vivah', 'namkaran', 'mrityunjaya'], 4.8, 377, 1490, 1.2, 'Vedic scholar who conducts rituals in Tamil and Sanskrit with English commentary.', '#8a2a10', 'verified', 1],
    ['p3', 'Pt. Vinod Mishra', 'Lucknow', 15, ['Hindi', 'Awadhi'], ['satyanarayan', 'hanuman', 'durga', 'pitru'], 4.7, 268, 880, 1, 'Specialises in katha and path recitation for family gatherings.', '#5b3b86', 'verified', 0],
    ['p4', 'Pt. Harish Joshi', 'Jaipur', 12, ['Hindi', 'Marwari'], ['ganesh', 'lakshmi', 'vyapar', 'saraswati'], 4.6, 190, 640, 0.95, 'Performs shop, office and vahan pujas across Jaipur.', '#b06a00', 'verified', 0],
    ['p5', 'Pt. Anand Bhatt', 'Ahmedabad', 20, ['Gujarati', 'Hindi', 'Sanskrit'], ['griha', 'vastu', 'kaalsarp', 'navgraha'], 4.8, 301, 1010, 1.1, 'Vastu and dosha nivaran specialist with 20 years of practice.', '#1d4d92', 'verified', 0],
    ['p6', 'Pt. Dinesh Pandey', 'Pune', 10, ['Marathi', 'Hindi'], ['ganesh', 'satyanarayan', 'namkaran', 'griha'], 4.5, 140, 420, 0.9, 'Ganesh and life-event ceremonies in Marathi and Hindi.', '#a5201a', 'verified', 0],
    ['p7', 'Acharya Gopal Rao', 'Bengaluru', 16, ['Kannada', 'Telugu', 'English'], ['durga', 'lakshmi', 'rudra', 'vivah'], 4.7, 215, 760, 1.05, 'Conducts pujas in Kannada, Telugu and English for families across Bengaluru.', '#1f6a3a', 'verified', 0],
    ['p8', 'Pt. Mahesh Tiwari', 'Varanasi', 22, ['Hindi', 'Sanskrit'], ['rudra', 'pitru', 'mrityunjaya', 'kaalsarp'], 4.9, 330, 1180, 1.1, 'Pitru and Shiva rituals from Kashi tradition.', '#6b4e00', 'verified', 0],
    ['p9', 'Pt. Sanjay Dubey', 'Hyderabad', 7, ['Hindi', 'Telugu'], ['ganesh', 'satyanarayan'], 0, 0, 0, 0.9, 'Recently applied to join DaivikPooja.', '#555555', 'pending', 0],
    ['p10', 'Pt. Rakesh Pathak', 'Delhi NCR', 9, ['Hindi'], ['hanuman', 'lakshmi'], 0, 0, 0, 0.9, 'Recently applied to join DaivikPooja.', '#555555', 'pending', 0]
  ];
  P.forEach((p, i) => {
    const mobile = '98100000' + String(i + 1).padStart(2, '0'), uid = 'pu' + (i + 1);
    db.prepare("INSERT INTO users(id,role,name,mobile,joined,created_at) VALUES(?,'pandit',?,?,?,?)").run(uid, p[1], mobile, addDays(-300), Date.now());
    db.prepare('INSERT INTO pandits(id,user_id,name,city,exp,langs,spec,rating,rev,done,pf,bio,color,status,featured,off,mobile,avail,kyc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)')
      .run(p[0], uid, p[1], p[2], p[3], JSON.stringify(p[4]), JSON.stringify(p[5]), p[6], p[7], p[8], p[9], p[10], p[11], p[12], p[13], '[]', mobile, JSON.stringify({ files: p[12] === 'pending' ? { id: 'demo-id.pdf' } : {} }));
  });

  const mk = (pujaId, mode, pid, day, slot, status, uid, sam = [], pra = [], review = null, refund = null) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
    const pr = svc.priceRequest(u, { pujaId, mode, panditId: pid, sam, pra });
    const addr = mode === 'online' ? { line: 'Online (video call)', city: JSON.parse(u.addr)[0].city, pin: '' } : JSON.parse(u.addr)[0];
    const seq = db.prepare('SELECT COUNT(*) c FROM bookings').get().c + 1;
    const temple = mode === 'temple' ? catalog.temples.find((t) => t.pujas.includes(pujaId)).id : null;
    const accepted = ['Assigned', 'Started', 'Completed'].includes(status);
    db.prepare(`INSERT INTO bookings(id,user_id,puja_id,mode,date,slot,addr,temple_id,pandit_id,pst,sam,pra,notes,member,coupon,q,status,pay,ops,media,review,created,log,refund)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'','Self','',?,?,?,?,?,?,?,?,?)`).run('DP' + (2400 + seq), uid, pujaId, mode, addDays(day), slot, mode === 'temple' ? null : JSON.stringify(addr), temple, pid, pid ? (accepted ? 'accepted' : 'pending') : null,
      JSON.stringify(sam), JSON.stringify(pra), JSON.stringify(pr.q), status, JSON.stringify({ method: 'UPI', ref: 'UPI' + (88000 + seq * 13), paid: true }),
      JSON.stringify({ sam: sam.length ? (['Completed', 'Started'].includes(status) ? 'Delivered' : 'Packed') : '', pra: (pra.length || mode === 'temple') && status === 'Completed' ? 'Dispatched' : '' }),
      JSON.stringify([]), review && JSON.stringify(review), Date.now() - Math.abs(day) * 864e5, JSON.stringify([['Booking confirmed', addDays(day - 4)], [status, addDays(day)]]), refund && JSON.stringify(refund));
  };
  mk('lakshmi', 'home', 'p1', -30, '06:00 PM', 'Completed', 'u1', ['k_lakshmi'], ['pr1'], { r: 5, t: 'Very organised. Pandit ji explained every step.', by: 'Aarav Mehta', on: addDays(-29) });
  mk('satyanarayan', 'online', 'p3', -18, '10:00 AM', 'Completed', 'u2', [], [], { r: 5, t: 'My parents joined from Jaipur. Lovely experience.', by: 'Priya Nair', on: addDays(-17) });
  mk('griha', 'home', 'p5', -12, '08:00 AM', 'Completed', 'u3', ['k_griha'], [], { r: 4, t: 'Good service. Samagri came a little late.', by: 'Karan Desai', on: addDays(-11) });
  mk('rudra', 'temple', 'p8', -9, '08:00 AM', 'Completed', 'u4', [], ['pr4']);
  mk('ganesh', 'home', 'p4', -6, '10:00 AM', 'Cancelled', 'u5', [], [], null, { amt: 1500, pct: 100, state: 'Processed' });
  mk('satyanarayan', 'home', 'p1', 0, '06:00 PM', 'Assigned', 'u1', ['k_satya']);
  mk('durga', 'home', 'p7', 3, '08:00 AM', 'Confirmed', 'u2', ['k_nav']);
  mk('ganesh', 'online', 'p6', 5, '12:00 PM', 'Confirmed', 'u3');
  mk('navgraha', 'home', 'p1', 7, '10:00 AM', 'Confirmed', 'u4');
  mk('hanuman', 'home', 'p3', 9, '04:00 PM', 'Confirmed', 'u5');
  mk('lakshmi', 'home', 'p1', 12, '06:00 PM', 'Confirmed', 'u1', ['k_lakshmi'], ['pr2']);
  mk('vyapar', 'home', null, 14, '10:00 AM', 'New', 'u3');
  /* u6-u10: every demo customer has at least one booking */
  mk('lakshmi', 'home', 'p1', -5, '06:00 PM', 'Completed', 'u6', [], ['pr2'], { r: 5, t: 'Smooth booking and a peaceful puja.', by: 'Sunita Rao', on: addDays(-4) });
  mk('hanuman', 'home', 'p3', 11, '04:00 PM', 'Confirmed', 'u7', ['k_havan']);
  mk('ganesh', 'home', 'p4', -3, '12:00 PM', 'Completed', 'u8', [], [], { r: 5, t: 'Perfect for our new office. Pandit was on time.', by: 'Anjali Patel', on: addDays(-2) });
  mk('durga', 'home', 'p7', -4, '10:00 AM', 'Completed', 'u9', ['k_nav'], [], { r: 5, t: 'Pandit ji explained every step in Hindi. Felt blessed.', by: 'Neha Gupta', on: addDays(-3) });
  mk('satyanarayan', 'home', 'p1', 4, '10:00 AM', 'Confirmed', 'u9', ['k_satya']);
  mk('ganesh', 'online', 'p6', -8, '12:00 PM', 'Completed', 'u10', [], [], { r: 4, t: 'Clear video call and a well-conducted puja.', by: 'Arjun Menon', on: addDays(-7) });
  mk('navgraha', 'home', 'p5', 8, '08:00 AM', 'Confirmed', 'u10', ['k_nav']);
  const seq = db.prepare('SELECT COUNT(*) c FROM bookings').get().c;
  setSetting('booking_seq', 2400 + seq);

  db.prepare("INSERT INTO payouts(id,pandit_id,amount,date,status,booking_id) VALUES('PO1','p1',8200,?,'Paid',NULL),('PO2','p2',12400,?,'Paid',NULL),('PO3','p1',3100,?,'Pending',NULL)").run(addDays(-20), addDays(-20), addDays(-5));
  db.prepare("INSERT INTO orders(id,user_id,items,total,date,status,city) VALUES('OR1001','u1',?,549,?,'Delivered','Delhi NCR'),('OR1002','u4',?,1102,?,'Dispatched','Chennai')").run(JSON.stringify([{ k: 'k_havan', q: 1 }]), addDays(-14), JSON.stringify([{ k: 'pr3', q: 2 }]), addDays(-3));
  db.prepare("INSERT INTO tickets(id,user_id,booking_id,text,status,prio) VALUES('TK1','u3','DP2403','Samagri arrived late','Open','Medium'),('TK2','u5','DP2405','Refund status query','Resolved','Low'),('TK3','u2','DP2407','Change of address request','Open','High')").run();
  db.prepare("INSERT INTO campaigns(id,name,channel,audience,status,sent) VALUES('C1','Diwali early bird','WhatsApp','Repeat customers','Scheduled',0),('C2','Pitru Paksha reminder','Email','All customers','Sent',1280)").run();
  db.prepare("INSERT INTO banners(id,text,enabled) VALUES('b2','Pitru Paksha tarpan at Trimbakeshwar',1)").run();
  db.prepare("INSERT INTO notifs(user_id,channel,message,ts) VALUES('u1','WhatsApp','Your Satyanarayan Katha is assigned to Pt. Ramesh Sharma.',?)").run(Date.now() - 36e5);

  /* Mock kundalis through the REAL engine (no hard-coded charts), saved for the demo
     customers so /#/kundali/result?id= and the admin Kundali tab have history. */
  try {
    const astro = require('./services/astrology');
    const places = db.prepare('SELECT * FROM place_index WHERE city IN (?, ?, ?, ?, ?) AND country=? ORDER BY population DESC').all('Delhi', 'Chennai', 'Mumbai', 'Kolkata', 'Kochi', 'India');
    const byCity = Object.fromEntries(places.map((p) => [p.city, p]));
    const samples = [
      ['u1', 'Aarav Mehta', '1990-01-15', '10:30', 'exact', byCity.Delhi, 'Marriage'],
      ['u4', 'Meera Iyer', '1987-07-04', '06:45', 'exact', byCity.Chennai, 'Health & Wellness'],
      ['u3', 'Karan Desai', '1995-11-02', '14:10', 'exact', byCity.Mumbai, 'Career'],
      ['u9', 'Neha Gupta', '1992-03-21', '09:15', 'exact', byCity.Kolkata, 'Family'],
      ['u10', 'Arjun Menon', '1988-09-09', '18:20', 'exact', byCity.Kochi, 'Business']
    ];
    for (const [uid, name, dob, tob, acc, place, purpose] of samples) {
      if (!place) continue;
      const chart = astro.kundali.buildChart({ name, gender: dob === '1987-07-04' || dob === '1992-03-21' ? 'female' : 'male', dob, tob, birthTimeAccuracy: acc, lat: place.lat, lon: place.lon, tz: place.tz, place: [place.city, place.state, place.country].join(', '), city: place.city, state: place.state, country: place.country });
      const results = astro.dosh.analyze(chart);
      const detected = astro.dosh.detected(results);
      const recs = astro.recommend.recommendationsFor(detected, { purpose });
      const kid = 'K' + rid(6);
      db.prepare(`INSERT INTO kundalis(id,profile_id,name,chart_data,planetary_data,lagna,rashi,nakshatra,pada,dasha_data,navamsa_data,calculation_version)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(kid, null, name, JSON.stringify(chart), JSON.stringify(astro.kundali.analysisView(chart)),
          chart.lagna.signName, chart.rashi.signName, chart.panchang.nakshatra, chart.planets.moon.nakshatra.pada,
          JSON.stringify(chart.dashas), JSON.stringify(chart.navamsaSigns), 'internal-ephemeris-v1');
      const insDosh = db.prepare('INSERT INTO dosh_analysis(kundali_id,dosh_type,detected,severity,confidence,explanation,evidence,recommendation) VALUES(?,?,?,?,?,?,?,?)');
      for (const r of results) insDosh.run(kid, r.code, r.detected ? 1 : 0, r.severity, r.confidence, r.explanation, JSON.stringify(r.evidence), '');
      const insRec = db.prepare('INSERT INTO puja_recommendations(kundali_id,puja_id,recommendation_reason,priority,relevance_score,related_doshas) VALUES(?,?,?,?,?,?)');
      for (const r of recs) insRec.run(kid, r.pujaId, r.reason, r.priority, r.weight, JSON.stringify(r.relatedDoshas));
      db.prepare('INSERT INTO kundali_activity(user_id,action,detail) VALUES(?,?,?)').run(uid, 'kundali.generate', JSON.stringify({ kundaliId: kid, detected: detected.length, recommendations: recs.length }));
    }
  } catch (e) { if (!process.env.QUIET) console.warn('[seed] demo kundalis skipped:', e.message); }
}

/* Kundali module seed: condition -> puja rules, havan kunds and samagri for the
   recommended pujas. Runs after seedCatalog (needs pujas). Idempotent, and safe on
   databases where pujas were added by migration 004 instead of the JSON seed. */
function seedKundaliCatalog() {
  const hasPuja = (id) => !!db.prepare('SELECT 1 FROM pujas WHERE id=?').get(id);
  const txrun = db.transaction(() => {
    /* Rule mapping: condition -> (puja, weight, priority, reason). Admins can edit or
       extend these in the admin panel; this seed only fills a fresh install. */
    const rules = [
      ['mangal_dosha', 'mangal', 10, 'primary', 'Mangal Dosh Nivaran Puja is the traditional remedy associated with the Mars combination identified in this chart.'],
      ['mangal_dosha', 'vivah', 5, 'secondary', 'A Mars-focused chart is traditionally matched and addressed before marriage.'],
      ['mangal_dosha', 'navgraha', 3, 'optional', 'Navagraha Shanti is a supplementary practice for planetary peace.'],
      ['kaal_sarp', 'kaalsarp', 10, 'primary', 'Kaal Sarp Dosh Nivaran is the traditional remedy associated with the Rahu-Ketu axis combination.'],
      ['kaal_sarp', 'rudra', 6, 'secondary', 'Rudrabhishek is traditionally performed alongside Kaal Sarp shanti.'],
      ['pitru_dosha', 'pitru', 10, 'primary', 'Pitru Tarpan and Shraddha is the traditional seva associated with ancestral combinations.'],
      ['grahan_dosha', 'navgraha', 8, 'primary', 'Navagraha Shanti havan is the traditional remedy for an eclipse-like Sun-Moon node combination.'],
      ['grahan_dosha', 'mrityunjaya', 5, 'secondary', 'Mahamrityunjaya jaap is traditionally recited for protection alongside Grahan shanti.'],
      ['guru_chandal', 'navgraha', 8, 'primary', 'Navagraha Shanti havan is the traditional remedy associated with a Jupiter-node combination.'],
      ['guru_chandal', 'rudra', 5, 'secondary', 'Rudrabhishek is traditionally performed to pacify Jupiter-related combinations.'],
      ['shani_condition', 'shani', 10, 'primary', 'Shani shanti puja is the traditional remedy associated with Saturn conditions and Sade Sati.'],
      ['shani_condition', 'navgraha', 5, 'secondary', 'Navagraha Shanti is a supplementary practice for Saturn periods.'],
      ['rahu_condition', 'kaalsarp', 7, 'primary', 'Kaal Sarp Dosh Nivaran includes Rahu shanti in the traditional sequence.'],
      ['rahu_condition', 'durga', 5, 'secondary', 'Durga Saptashati path is traditionally recited for Rahu pacification.'],
      ['ketu_condition', 'kaalsarp', 7, 'primary', 'Kaal Sarp Dosh Nivaran includes Ketu shanti in the traditional sequence.'],
      ['ketu_condition', 'ganesh', 5, 'secondary', 'Ganesha worship is traditionally associated with Ketu pacification.']
    ];
    const insRule = db.prepare('INSERT OR IGNORE INTO condition_puja_rules(condition_code,puja_id,weight,priority,reason) VALUES(?,?,?,?,?)');
    for (const [code, pujaId, weight, priority, reason] of rules) if (hasPuja(pujaId)) insRule.run(code, pujaId, weight, priority, reason);

    /* Upgrade rows that migration 002 created without priority/reason. */
    db.prepare("UPDATE condition_puja_rules SET priority='primary', reason='Mangal Dosh Nivaran Puja is the traditional remedy associated with the Mars combination identified in this chart.' WHERE condition_code='mangal_dosha' AND puja_id='mangal'").run();
    db.prepare("UPDATE condition_puja_rules SET priority='secondary', reason='A Mars-focused chart is traditionally matched and addressed before marriage.' WHERE condition_code='mangal_dosha' AND puja_id='vivah'").run();
    db.prepare("UPDATE condition_puja_rules SET priority='primary', reason='Pitru Tarpan and Shraddha is the traditional seva associated with ancestral combinations.' WHERE condition_code='pitru_dosha' AND puja_id='pitru'").run();
    db.prepare("UPDATE condition_puja_rules SET priority='primary', reason='Rudrabhishek is the traditional seva associated with the Rahu-Ketu axis when no dedicated puja is mapped.' WHERE condition_code='kaal_sarp' AND puja_id='rudra' AND NOT EXISTS(SELECT 1 FROM condition_puja_rules WHERE condition_code='kaal_sarp' AND puja_id='kaalsarp')").run();

    /* Havan kunds and samagri for the recommended pujas. */
    const kunds = [
      ['mangal', 'hk_brass_12', 1], ['kaalsarp', 'hk_stone_15', 1], ['shani', 'hk_brass_12', 1],
      ['navgraha', 'hk_copper_9', 1], ['pitru', 'hk_copper_9', 1]
    ];
    for (const [pujaId, kundId, rec] of kunds) if (hasPuja(pujaId)) db.prepare('INSERT OR IGNORE INTO puja_kunds(puja_id,kund_id,recommended) VALUES(?,?,?)').run(pujaId, kundId, rec);
    const samagri = [
      ['navgraha', 'si_ghee', 250], ['navgraha', 'si_camphor', 10], ['kaalsarp', 'si_til', 100],
      ['pitru', 'si_til', 250], ['pitru', 'si_akshat', 100], ['mangal', 'si_ghee', 250],
      ['mangal', 'si_wood', 21], ['shani', 'si_til', 250], ['shani', 'si_ghee', 250]
    ];
    for (const [pujaId, itemId, qty] of samagri) if (hasPuja(pujaId)) db.prepare('INSERT OR IGNORE INTO puja_samagri(puja_id,item_id,qty) VALUES(?,?,?)').run(pujaId, itemId, qty);
  })();
  void txrun;
}

function resetAll() {
  /* Foreign keys are ON, so child tables must go before their parents. Ordered:
     kundali flow -> analytics/history -> transactional -> catalogue -> identity. */
  const order = [
    /* IMPORTANT:
       These tables are explicitly allowlisted for demo/reset deletion.
       Do not expand this list without reviewing production data impact.
       Order matters: children are deleted before the parents they reference. */
    'puja_recommendations', 'dosh_analysis', 'kundalis', 'kundali_recommendations',
    'kundali_analysis', 'kundali_profiles', 'kundali_activity',
    'booking_status_history', 'payments', 'reviews', 'payouts', 'ticket_messages',
    'tickets', 'cart_items', 'order_items', 'orders', 'bookings',
    'notifs', 'campaigns', 'leads', 'audit_logs',
    'puja_kunds', 'puja_samagri', 'condition_puja_rules', 'temple_pujas',
    'coupons', 'banners', 'otps', 'settings',
    'kits', 'prasad', 'temples', 'festivals', 'havan_kunds', 'samagri_items', 'kundali_conditions',
    'custom_requests',
    'family_members', 'export_logs', 'idempotency_keys',
    'puja_media', 'login_activity', 'password_resets',
    'pandits', 'pujas', 'users'
  ];
  tx(() => {
    for (const t of order) { try { db.prepare('DELETE FROM ' + t).run(); } catch (e) { /* table may not exist on older databases */ } }
  })();
  replayMigrationSeeds();
}

/* Applies pending SQL migrations from server/migrations/ (same logic as migrate.js,
   so `npm start` always boots with the current schema without a separate step). */
function runMigrations() {
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(dir)) return;
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const pending = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().filter((f) => !done.has(f));
  if (pending.length) for (const file of pending) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const apply = db.transaction(() => { db.exec(sql); db.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run(file); });
    try { apply(); if (!process.env.QUIET) console.log('[migrate] applied ' + file); }
    catch (err) { console.error('[migrate] FAILED ' + file + ': ' + err.message + ' — fix server/migrations/' + file + ' and re-run (nothing else was touched).'); throw err; }
  }
}

/* Replays migration seed data after a full wipe (place index, kunds, samagri items,
   condition rows). Safe on untouched databases too: every statement is guarded by
   NOT EXISTS / INSERT OR IGNORE. Each statement is isolated so one failure (e.g. a
   rule row referencing a puja that is not re-seeded yet) cannot abort the rest. */
function replayMigrationSeeds() {
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    /* Comments must go BEFORE splitting on ';': a comment can contain a semicolon
       ("...from migration 002; align..."), which would otherwise split mid-comment
       and make the following INSERT chunk start with comment residue. */
    const noComments = sql.replace(/--[^\n]*/g, '');
    for (const stmt of noComments.split(';')) {
      const s = stmt.trim();
      if (!s) continue;
      if (/^(ALTER|CREATE|DROP|UPDATE|DELETE)\b/i.test(s)) continue;   /* structure + data fixes are migration-time only */
      if (!/^INSERT/i.test(s)) continue;                                /* replay seed inserts only */
      try { db.exec(s + ';'); }
      catch (e) { if (!process.env.QUIET) console.warn('[seed] replay skip (' + file + '):', e.message); }
    }
  }
}

/* Re-applies the Hindi catalog backfills (conditions, mapping reasons, puja benefits)
   so the bilingual content is present even on databases where migrations 006/007 ran
   long ago and seed rows were wiped by a demo RESET. Idempotent: guarded UPDATEs. */
function backfillHindi() {
  const fs = require('fs'), path = require('path');
  for (const file of ['006_kundali_hindi_place.sql', '007_puja_management.sql']) {
    const p = path.join(__dirname, 'migrations', file);
    if (!fs.existsSync(p)) continue;
    const noComments = fs.readFileSync(p, 'utf8').replace(/--[^\n]*/g, '');
    for (const stmt of noComments.split(';')) {
      const s = stmt.trim();
      if (!/^UPDATE\b/i.test(s)) continue;
      try { db.exec(s + ';'); } catch (e) { if (!process.env.QUIET) console.warn('[seed] hindi backfill skip (' + file + '):', e.message); }
    }
  }
  /* Data-integrity fix that normally runs only at migration time (005): the legacy
     shani_dasha condition is superseded by the shani_condition rule. A demo RESET
     replays the 002 INSERT with active=1, so re-disable it on every boot. */
  try { db.exec("UPDATE kundali_conditions SET active=0 WHERE code='shani_dasha' AND EXISTS(SELECT 1 FROM kundali_conditions WHERE code='shani_condition')"); } catch (e) { /* older database without the table */ }
  /* RESET-safe defaults for the kundali commercial model and service toggles.
     setSetting uses upsert, so an admin's saved prices survive: only a missing
     setting is created. */
  try { setSetting('kundali_pricing', getSetting2('kundali_pricing', { active: true, currency: 'INR', personalPrice: 0, familyPrice: 499, additionalPrice: 499, gstPct: 5, discountPct: 0, couponEligible: true, freeCounts: { customer: 1, plus: 2, premium: 5 } })); } catch (e) { /* older database */ }
  try { setSetting('service_toggles', getSetting2('service_toggles', { home: true, online: true, temple: true, customized: true, kundali: true, pandit: true, templeDir: true, prasad: true, samagri: true, astrology: true })); } catch (e) { /* older database */ }
}

function bootstrap() { runMigrations(); seedCatalog(); seedKundaliCatalog(); backfillHindi(); ensureAdmin(); if (demoOn()) seedDemo();
  /* Bundled puja photos (freely licensed, see shared/seed-photos/CREDITS.md): copied
     into puja_media once per puja. Pujas that already have media are never touched. */
  try {
    const { seedPujaPhotos } = require('./services/photoSeed');
    Promise.resolve(seedPujaPhotos()).then((r) => { if ((r.seeded || r.variants) && !process.env.QUIET) console.log('[photoSeed] ' + r.seeded + ' seeded, ' + r.skipped + ' already had photos, ' + (r.variants || 0) + ' variants'); }).catch(() => {});
  } catch (e) { console.error('[photoSeed]', e.message); }
  /* WebP variant repair for any rows missing them (no-op when everything exists). */
  try { require('./services/mediaVariants').repairAll().then((r) => { if (r.processed && !process.env.QUIET) console.log('[mediaVariants] repaired ' + r.generated + '/' + r.processed); }).catch(() => {}); } catch (e) { /* optional */ } }

/* getSetting without crashing when the settings table does not exist yet. */
function getSetting2(k, d) { try { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? JSON.parse(r.value) : d; } catch (e) { return d; } }

module.exports = { bootstrap, seedCatalog, seedKundaliCatalog, seedDemo, ensureAdmin, resetAll, demoOn };

if (require.main === module) {
  if (process.argv.includes('--reset')) { resetAll(); console.log('Database cleared.'); }
  bootstrap();
  console.log('Seed complete. Demo data:', demoOn() ? 'on' : 'off');
}

/* Counted demo data (used by the admin Demo data tab and tests). */
function demoStats() {
  const c = (sql, ...args) => db.prepare(sql).get(...args).c;
  return {
    demo: demoOn(),
    customers: c("SELECT COUNT(*) c FROM users WHERE role='customer'"),
    pandits: c('SELECT COUNT(*) c FROM pandits'),
    bookings: c('SELECT COUNT(*) c FROM bookings'),
    orders: c('SELECT COUNT(*) c FROM orders'),
    tickets: c('SELECT COUNT(*) c FROM tickets'),
    kundalis: c('SELECT COUNT(*) c FROM kundalis'),
    doshDetected: c('SELECT COUNT(*) c FROM dosh_analysis WHERE detected=1'),
    recommendations: c('SELECT COUNT(*) c FROM puja_recommendations')
  };
}

/* Generate N realistic mock bookings spread across the seeded demo customers, pujas,
   modes and dates, using the real booking service so pricing/stock/log stay consistent. */
function mockBookings(n) {
  if (!demoOn()) throw Object.assign(new Error('Demo mode is off; enable DEMO_MODE to generate mock data.'), { status: 400 });
  const count = Math.max(1, Math.min(50, Number(n) || 5));
  const svc = require('./services/bookings');
  const users = db.prepare("SELECT * FROM users WHERE role='customer' ORDER BY id").all();
  const pujas = db.prepare('SELECT id FROM pujas WHERE hidden=0 ORDER BY id').all().map((r) => r.id);
  const temples = db.prepare('SELECT id, pujas FROM temples').all();
  if (!users.length || !pujas.length) throw Object.assign(new Error('Seed the catalogue first: run `npm run reset`.'), { status: 400 });
  const slots = ['06:00 AM', '08:00 AM', '10:00 AM', '12:00 PM', '02:00 PM', '04:00 PM', '06:00 PM'];
  const cities = ['Delhi NCR', 'Mumbai', 'Bengaluru', 'Chennai', 'Jaipur', 'Hyderabad', 'Pune', 'Ahmedabad'];
  const pins = { 'Delhi NCR': '110016', Mumbai: '400020', Bengaluru: '560008', Chennai: '600004', Jaipur: '302006', Hyderabad: '500081', Pune: '411001', Ahmedabad: '380015' };
  const made = [];
  const run = tx(() => {
    for (let i = 0; i < count; i++) {
      const u = users[Math.floor(Math.random() * users.length)];
      const pujaId = pujas[Math.floor(Math.random() * pujas.length)];
      const temple = temples.find((t) => j(t.pujas, []).includes(pujaId));
      const mode = temple && Math.random() < 0.15 ? 'temple' : Math.random() < 0.3 ? 'online' : 'home';
      const date = addDays(2 + Math.floor(Math.random() * 45));
      const slot = slots[Math.floor(Math.random() * slots.length)];
      const kit = db.prepare('SELECT id FROM kits WHERE active=1 ORDER BY RANDOM() LIMIT 1').get();
      const prs = db.prepare('SELECT id FROM prasad WHERE active=1 ORDER BY RANDOM() LIMIT 1').get();
      const city = cities[Math.floor(Math.random() * cities.length)];
      let row = null;
      try {
        row = svc.createBooking(u, {
          pujaId, mode, date, slot,
          templeId: mode === 'temple' && temple ? temple.id : undefined,
          addr: mode === 'temple' ? undefined : { line: 'House ' + (10 + Math.floor(Math.random() * 90)) + ', ' + city, city, pin: pins[city] || '' },
          sam: kit && Math.random() < 0.5 ? [kit.id] : [],
          pra: prs && Math.random() < 0.3 ? [prs.id] : [],
          member: 'Self', payMethod: 'UPI'
        });
      } catch (e) { continue; } /* slot clash or stock: skip this one */
      if (row) made.push(row.id);
    }
  });
  run();
  return { created: made.length, ids: made, requested: count };
}

module.exports = { bootstrap, seedCatalog, seedKundaliCatalog, seedDemo, ensureAdmin, resetAll, demoOn, demoStats, mockBookings, DEMO_PASSWORD };
