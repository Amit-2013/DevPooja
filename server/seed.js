require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db, tx, setSetting } = require('./db');
const { addDays, today } = require('./lib/util');
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
    [['DEVPOOJA10', 'pct', 10, 500, 1500], ['FIRST100', 'flat', 100, 100, 1000], ['FESTIVE15', 'pct', 15, 750, 3000]].forEach((c) => db.prepare('INSERT INTO coupons(code,type,val,max,min,active,used) VALUES(?,?,?,?,?,1,0)').run(...c));
    db.prepare('INSERT INTO banners(id,text,enabled) VALUES(?,?,1)').run('b1', 'Diwali Lakshmi Puja: book early');
  })();
}

function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || (isProd() ? '' : 'admin@devpooja.in')).toLowerCase();
  const pass = process.env.ADMIN_PASSWORD || (isProd() ? '' : 'admin123');
  if (!email || !pass) { console.warn('[seed] No admin account created. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env'); return; }
  const hash = bcrypt.hashSync(pass, 10);
  const ex = db.prepare("SELECT id FROM users WHERE role='admin' AND email=?").get(email);
  if (ex) db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hash, ex.id);
  else db.prepare("INSERT INTO users(id,role,name,email,pass_hash,joined,created_at) VALUES(?,?,?,?,?,?,?)").run('admin1', 'admin', 'Administrator', email, hash, today(), Date.now());
}

function seedDemo() {
  if (db.prepare("SELECT COUNT(*) c FROM users WHERE role='customer'").get().c) return;
  const svc = require('./services/bookings');
  const insU = db.prepare("INSERT INTO users(id,role,name,mobile,email,pts,plus,pref,addr,fam,joined,created_at) VALUES(?,'customer',?,?,?,?,?,?,?,?,?,?)");
  const U = [
    ['u1', 'Aarav Mehta', '9876543210', 'aarav@example.com', 240, 0, { deity: 'Lakshmi', lang: 'Hindi', wa: true, sms: true, em: true }, [{ id: 'a1', l: 'Home', line: 'B-204, Green Park Residency', city: 'Delhi NCR', pin: '110016' }], [{ id: 'f1', n: 'Kavita Mehta', rel: 'Mother', gotra: 'Kashyap' }, { id: 'f2', n: 'Riya Mehta', rel: 'Spouse', gotra: '' }], -160],
    ['u2', 'Priya Nair', '9811100002', 'priya@example.com', 90, 1, { deity: 'Ganesha', lang: 'English', wa: true, sms: false, em: true }, [{ id: 'a2', l: 'Home', line: '12 Lake View Road', city: 'Bengaluru', pin: '560008' }], [], -120],
    ['u3', 'Karan Desai', '9811100003', 'karan@example.com', 0, 0, { deity: 'Shiva', lang: 'Hindi', wa: true, sms: true, em: false }, [{ id: 'a3', l: 'Home', line: '44 Marine Drive Apartments', city: 'Mumbai', pin: '400020' }], [], -70],
    ['u4', 'Meera Iyer', '9811100004', 'meera@example.com', 410, 1, { deity: 'Lakshmi', lang: 'Tamil', wa: true, sms: true, em: true }, [{ id: 'a4', l: 'Home', line: '8 Temple Street, Mylapore', city: 'Chennai', pin: '600004' }], [], -200],
    ['u5', 'Vikram Singh', '9811100005', 'vikram@example.com', 30, 0, { deity: 'Hanuman', lang: 'Hindi', wa: true, sms: true, em: false }, [{ id: 'a5', l: 'Home', line: '21 Civil Lines', city: 'Jaipur', pin: '302006' }], [], -40]
  ];
  U.forEach((u) => insU.run(u[0], u[1], u[2], u[3], u[4], u[5], JSON.stringify(u[6]), JSON.stringify(u[7]), JSON.stringify(u[8]), addDays(u[9]), Date.now()));

  const P = [
    ['p1', 'Pt. Ramesh Sharma', 'Delhi NCR', 18, ['Hindi', 'Sanskrit'], ['lakshmi', 'griha', 'satyanarayan', 'vastu', 'vyapar'], 4.9, 412, 1260, 1.15, 'Trained in Varanasi. Known for clear explanations of each ritual step in Hindi.', '#0c4b49', 'verified', 1],
    ['p2', 'Acharya Suresh Iyer', 'Chennai', 24, ['Tamil', 'Sanskrit', 'English'], ['rudra', 'navgraha', 'vivah', 'namkaran', 'mrityunjaya'], 4.8, 377, 1490, 1.2, 'Vedic scholar who conducts rituals in Tamil and Sanskrit with English commentary.', '#8a2a10', 'verified', 1],
    ['p3', 'Pt. Vinod Mishra', 'Lucknow', 15, ['Hindi', 'Awadhi'], ['satyanarayan', 'hanuman', 'durga', 'pitru'], 4.7, 268, 880, 1, 'Specialises in katha and path recitation for family gatherings.', '#5b3b86', 'verified', 0],
    ['p4', 'Pt. Harish Joshi', 'Jaipur', 12, ['Hindi', 'Marwari'], ['ganesh', 'lakshmi', 'vyapar', 'saraswati'], 4.6, 190, 640, 0.95, 'Performs shop, office and vahan pujas across Jaipur.', '#b06a00', 'verified', 0],
    ['p5', 'Pt. Anand Bhatt', 'Ahmedabad', 20, ['Gujarati', 'Hindi', 'Sanskrit'], ['griha', 'vastu', 'kaalsarp', 'navgraha'], 4.8, 301, 1010, 1.1, 'Vastu and dosha nivaran specialist with 20 years of practice.', '#1d4d92', 'verified', 0],
    ['p6', 'Pt. Dinesh Pandey', 'Pune', 10, ['Marathi', 'Hindi'], ['ganesh', 'satyanarayan', 'namkaran', 'griha'], 4.5, 140, 420, 0.9, 'Ganesh and life-event ceremonies in Marathi and Hindi.', '#a5201a', 'verified', 0],
    ['p7', 'Acharya Gopal Rao', 'Bengaluru', 16, ['Kannada', 'Telugu', 'English'], ['durga', 'lakshmi', 'rudra', 'vivah'], 4.7, 215, 760, 1.05, 'Conducts pujas in Kannada, Telugu and English for families across Bengaluru.', '#1f6a3a', 'verified', 0],
    ['p8', 'Pt. Mahesh Tiwari', 'Varanasi', 22, ['Hindi', 'Sanskrit'], ['rudra', 'pitru', 'mrityunjaya', 'kaalsarp'], 4.9, 330, 1180, 1.1, 'Pitru and Shiva rituals from Kashi tradition.', '#6b4e00', 'verified', 0],
    ['p9', 'Pt. Sanjay Dubey', 'Hyderabad', 7, ['Hindi', 'Telugu'], ['ganesh', 'satyanarayan'], 0, 0, 0, 0.9, 'Recently applied to join DevPooja.', '#555555', 'pending', 0],
    ['p10', 'Pt. Rakesh Pathak', 'Delhi NCR', 9, ['Hindi'], ['hanuman', 'lakshmi'], 0, 0, 0, 0.9, 'Recently applied to join DevPooja.', '#555555', 'pending', 0]
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
  const seq = db.prepare('SELECT COUNT(*) c FROM bookings').get().c;
  setSetting('booking_seq', 2400 + seq);

  db.prepare("INSERT INTO payouts(id,pandit_id,amount,date,status,booking_id) VALUES('PO1','p1',8200,?,'Paid',NULL),('PO2','p2',12400,?,'Paid',NULL),('PO3','p1',3100,?,'Pending',NULL)").run(addDays(-20), addDays(-20), addDays(-5));
  db.prepare("INSERT INTO orders(id,user_id,items,total,date,status,city) VALUES('OR1001','u1',?,549,?,'Delivered','Delhi NCR'),('OR1002','u4',?,1102,?,'Dispatched','Chennai')").run(JSON.stringify([{ k: 'k_havan', q: 1 }]), addDays(-14), JSON.stringify([{ k: 'pr3', q: 2 }]), addDays(-3));
  db.prepare("INSERT INTO tickets(id,user_id,booking_id,text,status,prio) VALUES('TK1','u3','DP2403','Samagri arrived late','Open','Medium'),('TK2','u5','DP2405','Refund status query','Resolved','Low'),('TK3','u2','DP2407','Change of address request','Open','High')").run();
  db.prepare("INSERT INTO campaigns(id,name,channel,audience,status,sent) VALUES('C1','Diwali early bird','WhatsApp','Repeat customers','Scheduled',0),('C2','Pitru Paksha reminder','Email','All customers','Sent',1280)").run();
  db.prepare("INSERT INTO banners(id,text,enabled) VALUES('b2','Pitru Paksha tarpan at Trimbakeshwar',1)").run();
  db.prepare("INSERT INTO notifs(user_id,channel,message,ts) VALUES('u1','WhatsApp','Your Satyanarayan Katha is assigned to Pt. Ramesh Sharma.',?)").run(Date.now() - 36e5);
}

function resetAll() {
  ['bookings', 'orders', 'notifs', 'tickets', 'campaigns', 'leads', 'payouts', 'coupons', 'banners', 'settings', 'otps', 'pandits', 'users', 'pujas', 'kits', 'prasad', 'temples', 'festivals'].forEach((t) => db.prepare('DELETE FROM ' + t).run());
}
function bootstrap() { seedCatalog(); ensureAdmin(); if (demoOn()) seedDemo(); }

module.exports = { bootstrap, seedCatalog, seedDemo, ensureAdmin, resetAll, demoOn };

if (require.main === module) {
  if (process.argv.includes('--reset')) { resetAll(); console.log('Database cleared.'); }
  bootstrap();
  console.log('Seed complete. Demo data:', demoOn() ? 'on' : 'off');
}
