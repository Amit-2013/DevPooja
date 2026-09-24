const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const { db, setSetting, nextSeq } = require('../db');
const { requireRole, sign } = require('../auth');
const B = require('../services/bookings');
const S = require('../lib/serialize');
const upload = require('../lib/upload');
const { notify } = require('../services/notify');
const { v, bad, conflict, notFound, j, today, rid } = require('../lib/util');
const P = require('../../shared/pricing');

router.use(requireRole('admin'));
const one = (b) => S.booking(B.getBooking(b));

router.post('/bookings/manual', (req, res) => res.status(201).json({ booking: S.booking(B.adminManual(req.body)) }));
router.post('/bookings/:id/assign', (req, res) => res.json({ booking: S.booking(B.adminAssign(req.params.id, req.body.panditId || null)) }));
router.post('/bookings/:id/status', (req, res) => res.json({ booking: S.booking(B.adminStatus(req.params.id, req.body.status)) }));
router.post('/bookings/:id/refund', (req, res) => {
  const r = B.getBooking(req.params.id); if (!r || !r.refund) throw notFound('No refund on this booking');
  const rf = j(r.refund, {}); rf.state = 'Processed';
  const log = j(r.log, []); log.push(['Refund processed', today()]);
  db.prepare('UPDATE bookings SET refund=?, log=? WHERE id=?').run(JSON.stringify(rf), JSON.stringify(log), r.id);
  notify(r.user_id, 'Email', `Refund of Rs ${rf.amt} for ${r.id} processed.`);
  res.json({ booking: one(r.id) });
});
router.post('/bookings/:id/escalate', (req, res) => { const r = B.getBooking(req.params.id); if (!r) throw notFound(); db.prepare('UPDATE bookings SET esc=? WHERE id=?').run(r.esc ? 0 : 1, r.id); res.json({ booking: one(r.id) }); });
router.post('/bookings/:id/ops', (req, res) => {
  const r = B.getBooking(req.params.id); if (!r) throw notFound();
  const ops = j(r.ops, {});
  if (req.body.sam) ops.sam = v.oneOf(req.body.sam, ['Packed', 'Delivered'], 'Samagri status');
  if (req.body.pra) ops.pra = v.oneOf(req.body.pra, ['Dispatched', 'Delivered'], 'Prasad status');
  const log = j(r.log, []); log.push([req.body.sam ? 'Samagri ' + ops.sam.toLowerCase() : 'Prasad ' + ops.pra.toLowerCase(), today()]);
  db.prepare('UPDATE bookings SET ops=?, log=? WHERE id=?').run(JSON.stringify(ops), JSON.stringify(log), r.id);
  notify(r.user_id, 'SMS', `Update for ${r.id}: ${req.body.sam ? 'samagri ' + ops.sam.toLowerCase() : 'prasad ' + ops.pra.toLowerCase()}.`);
  res.json({ booking: one(r.id) });
});
router.post('/reviews/:id/toggle', (req, res) => { const r = B.getBooking(req.params.id); if (!r || !r.review) throw notFound(); db.prepare('UPDATE bookings SET review_hidden=? WHERE id=?').run(r.review_hidden ? 0 : 1, r.id); res.json({ ok: true }); });

router.post('/pandits/:id/kyc', (req, res) => {
  const st = v.oneOf(req.body.status, ['verified', 'rejected'], 'Status');
  const p = db.prepare('SELECT * FROM pandits WHERE id=?').get(req.params.id); if (!p) throw notFound();
  db.prepare('UPDATE pandits SET status=? WHERE id=?').run(st, p.id);
  res.json({ ok: true });
});
router.post('/pandits/:id/feature', (req, res) => { const p = db.prepare('SELECT * FROM pandits WHERE id=?').get(req.params.id); if (!p) throw notFound(); db.prepare('UPDATE pandits SET featured=? WHERE id=?').run(p.featured ? 0 : 1, p.id); res.json({ ok: true }); });
/* KYC documents are private: streamed only to admins */
router.get('/pandits/:id/docs/:key', (req, res) => {
  const p = db.prepare('SELECT kyc FROM pandits WHERE id=?').get(req.params.id); if (!p) throw notFound();
  const f = (j(p.kyc, {}).files || {})[req.params.key]; if (!f) throw notFound('Document not found');
  const file = path.join(upload.dirs.kyc, path.basename(f));
  if (!fs.existsSync(file)) throw notFound('File missing');
  res.sendFile(file);
});

router.post('/pujas', (req, res) => {
  const b = req.body, id = 'c' + rid(3);
  if (!db.prepare('SELECT 1 FROM kits WHERE id=?').get(b.kit)) throw bad('Choose a samagri kit');
  db.prepare('INSERT INTO pujas(id,name,hindi,cat,icon,dur,price,deity,ben,kit,pop,tags) VALUES(?,?,?,?,?,?,?,?,?,?,0,?)')
    .run(id, v.str(b.name, 'Name', { max: 80 }), v.str(b.hindi || b.name, 'Hindi name', { max: 80 }), v.str(b.cat, 'Category', { max: 40 }), '🕉️', v.int(b.dur, 'Duration', { min: 15, max: 720 }), v.int(b.price, 'Price', { min: 100, max: 1000000 }), 'Custom', 'Custom puja added by admin.', b.kit, String(b.name).toLowerCase());
  res.status(201).json({ id });
});
router.patch('/pujas/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM pujas WHERE id=?').get(req.params.id); if (!p) throw notFound();
  const b = req.body || {};
  if (b.name !== undefined) db.prepare('UPDATE pujas SET name=? WHERE id=?').run(v.str(b.name, 'Name', { max: 80 }), p.id);
  if (b.hindi !== undefined) db.prepare('UPDATE pujas SET hindi=? WHERE id=?').run(v.str(b.hindi, 'Hindi name', { max: 80, optional: true }), p.id);
  if (b.cat !== undefined) db.prepare('UPDATE pujas SET cat=? WHERE id=?').run(v.str(b.cat, 'Category', { max: 40 }), p.id);
  if (b.deity !== undefined) db.prepare('UPDATE pujas SET deity=? WHERE id=?').run(v.str(b.deity, 'Deity', { max: 60, optional: true }), p.id);
  if (b.ben !== undefined) db.prepare('UPDATE pujas SET ben=? WHERE id=?').run(v.str(b.ben, 'Benefits', { max: 500, optional: true }), p.id);
  if (b.benHi !== undefined) db.prepare('UPDATE pujas SET ben_hi=? WHERE id=?').run(v.str(b.benHi, 'Hindi benefits', { max: 500, optional: true }), p.id);
  if (b.dur !== undefined) db.prepare('UPDATE pujas SET dur=? WHERE id=?').run(v.int(b.dur, 'Duration', { min: 15, max: 720 }), p.id);
  if (b.kit !== undefined) { if (!db.prepare('SELECT 1 FROM kits WHERE id=?').get(b.kit)) throw bad('Choose a samagri kit'); db.prepare('UPDATE pujas SET kit=? WHERE id=?').run(b.kit, p.id); }
  if (b.price !== undefined) db.prepare('UPDATE pujas SET price=? WHERE id=?').run(v.int(b.price, 'Price', { min: 100, max: 1000000 }), p.id);
  if (b.hidden !== undefined) db.prepare('UPDATE pujas SET hidden=? WHERE id=?').run(b.hidden ? 1 : 0, p.id);
  res.json({ ok: true });
});
router.post('/settings', (req, res) => { setSetting('commission', v.int(req.body.commission, 'Commission', { min: 0, max: 60 })); res.json({ ok: true }); });
router.post('/coupons', (req, res) => {
  const b = req.body, code = v.str(b.code, 'Code', { max: 20 }).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) throw bad('Code is required');
  if (db.prepare('SELECT 1 FROM coupons WHERE code=?').get(code)) throw conflict('That code already exists');
  const type = v.oneOf(b.type, ['pct', 'flat'], 'Type'), val = v.int(b.val, 'Value', { min: 1, max: type === 'pct' ? 90 : 100000 });
  db.prepare('INSERT INTO coupons(code,type,val,max,min,active,used) VALUES(?,?,?,?,?,1,0)').run(code, type, val, v.int(b.max || val, 'Maximum', { min: 1 }), v.int(b.min || 1000, 'Minimum', { min: 0 }));
  res.status(201).json({ ok: true });
});
router.patch('/coupons/:code', (req, res) => { db.prepare('UPDATE coupons SET active=? WHERE code=?').run(req.body.active ? 1 : 0, req.params.code); res.json({ ok: true }); });
router.post('/payouts/:id/pay', (req, res) => { const r = db.prepare("UPDATE payouts SET status='Paid' WHERE id=?").run(req.params.id); if (!r.changes) throw notFound(); res.json({ ok: true }); });
router.patch('/banners/:id', (req, res) => { db.prepare('UPDATE banners SET enabled=? WHERE id=?').run(req.body.enabled ? 1 : 0, req.params.id); res.json({ ok: true }); });
router.post('/campaigns', (req, res) => {
  db.prepare("INSERT INTO campaigns(id,name,channel,audience,status,sent) VALUES(?,?,?,?,'Scheduled',0)").run('C' + nextSeq('campaign_seq', 3), v.str(req.body.name, 'Name', { max: 80 }), v.oneOf(req.body.channel, ['WhatsApp', 'Email', 'SMS', 'Push'], 'Channel'), v.oneOf(req.body.audience, ['All customers', 'Repeat customers', 'Plus members'], 'Audience'));
  res.status(201).json({ ok: true });
});
router.post('/push', (req, res) => {
  const m = v.str(req.body.message, 'Message', { max: 300 });
  const users = db.prepare("SELECT id FROM users WHERE role='customer'").all();
  users.forEach((u) => notify(u.id, 'Push', m));
  res.json({ sent: users.length });
});
router.post('/inventory/:kit/restock', (req, res) => { const r = db.prepare('UPDATE kits SET stock=stock+? WHERE id=?').run(v.int(req.body.qty || 20, 'Quantity', { min: 1, max: 5000 }), req.params.kit); if (!r.changes) throw notFound(); res.json({ ok: true }); });

/* --- samagri kit catalog management --- */
router.post('/kits', (req, res) => {
  const b = req.body;
  const name = v.str(b.name, 'Kit name', { max: 80 });
  const id = 'k_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) + '_' + rid(2);
  const items = v.arr(b.items, 'Kit contents', 40).map((x) => v.str(x, 'Kit contents', { max: 80 })).filter(Boolean);
  db.prepare('INSERT INTO kits(id,name,price,icon,items,stock,active) VALUES(?,?,?,?,?,?,1)')
    .run(id, name, v.int(b.price, 'Price', { min: 0, max: 1000000 }), '🧘', JSON.stringify(items), v.int(b.stock === undefined || b.stock === '' ? 20 : b.stock, 'Stock', { min: 0, max: 100000 }));
  res.status(201).json({ id });
});
router.patch('/kits/:id', (req, res) => {
  const k = db.prepare('SELECT * FROM kits WHERE id=?').get(req.params.id); if (!k) throw notFound('Kit not found');
  if (req.body.name !== undefined) db.prepare('UPDATE kits SET name=? WHERE id=?').run(v.str(req.body.name, 'Kit name', { max: 80 }), k.id);
  if (req.body.price !== undefined) db.prepare('UPDATE kits SET price=? WHERE id=?').run(v.int(req.body.price, 'Price', { min: 0, max: 1000000 }), k.id);
  if (req.body.stock !== undefined) db.prepare('UPDATE kits SET stock=? WHERE id=?').run(v.int(req.body.stock, 'Stock', { min: 0, max: 100000 }), k.id);
  if (req.body.active !== undefined) db.prepare('UPDATE kits SET active=? WHERE id=?').run(req.body.active ? 1 : 0, k.id);
  res.json({ ok: true });
});

/* --- prasad catalog management --- */
router.post('/prasad', (req, res) => {
  const b = req.body;
  const name = v.str(b.name, 'Prasad name', { max: 80 });
  const id = 'pr' + rid(3);
  db.prepare('INSERT INTO prasad(id,name,price,icon,descr,stock,active) VALUES(?,?,?,?,?,?,1)')
    .run(id, name, v.int(b.price, 'Price', { min: 0, max: 1000000 }), '🍬', v.str(b.descr || '', 'Description', { optional: true, max: 200 }), b.stock === undefined || b.stock === '' ? null : v.int(b.stock, 'Stock', { min: 0, max: 100000 }));
  res.status(201).json({ id });
});
router.patch('/prasad/:id', (req, res) => {
  const pr = db.prepare('SELECT * FROM prasad WHERE id=?').get(req.params.id); if (!pr) throw notFound('Prasad item not found');
  if (req.body.name !== undefined) db.prepare('UPDATE prasad SET name=? WHERE id=?').run(v.str(req.body.name, 'Prasad name', { max: 80 }), pr.id);
  if (req.body.price !== undefined) db.prepare('UPDATE prasad SET price=? WHERE id=?').run(v.int(req.body.price, 'Price', { min: 0, max: 1000000 }), pr.id);
  if (req.body.stock !== undefined) db.prepare('UPDATE prasad SET stock=? WHERE id=?').run(req.body.stock === null ? null : v.int(req.body.stock, 'Stock', { min: 0, max: 100000 }), pr.id);
  if (req.body.active !== undefined) db.prepare('UPDATE prasad SET active=? WHERE id=?').run(req.body.active ? 1 : 0, pr.id);
  res.json({ ok: true });
});

/* Deleting is refused while bookings, orders or carts still reference the item:
   their JSON would render broken. Deactivate instead — that is always safe.
   cart_items comes from a migration, so its presence is checked, not assumed. */
const likeId = (id) => '%' + JSON.stringify(id).slice(1, -1) + '%';
const hasCarts = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cart_items'").get();
const itemUsed = (id) =>
  db.prepare('SELECT COUNT(*) c FROM bookings WHERE sam LIKE ? OR pra LIKE ?').get(likeId(id), likeId(id)).c
  + db.prepare('SELECT COUNT(*) c FROM orders WHERE items LIKE ?').get(likeId(id)).c
  + (hasCarts ? db.prepare('SELECT COUNT(*) c FROM cart_items WHERE item_id=?').get(id).c : 0);
router.delete('/kits/:id', (req, res) => {
  const k = db.prepare('SELECT * FROM kits WHERE id=?').get(req.params.id); if (!k) throw notFound('Kit not found');
  if (db.prepare('SELECT 1 FROM pujas WHERE kit=? LIMIT 1').get(k.id)) throw conflict('This kit is assigned to a puja. Deactivate it instead.');
  if (itemUsed(k.id)) throw conflict('Past bookings or orders still reference this kit. Deactivate it instead.');
  db.prepare('DELETE FROM kits WHERE id=?').run(k.id); res.json({ ok: true });
});
router.delete('/prasad/:id', (req, res) => {
  const pr = db.prepare('SELECT * FROM prasad WHERE id=?').get(req.params.id); if (!pr) throw notFound('Prasad item not found');
  if (itemUsed(pr.id)) throw conflict('Past bookings or orders still reference this item. Deactivate it instead.');
  db.prepare('DELETE FROM prasad WHERE id=?').run(pr.id); res.json({ ok: true });
});
/* --- Kundali module management: conditions and condition -> puja rules --- */
const CONDITION_CODES = () => db.prepare('SELECT code FROM kundali_conditions').all().map((r) => r.code);

router.get('/kundali/conditions', (req, res) => {
  const rows = db.prepare(`
    SELECT c.code, c.name, c.descr, c.severity, c.remedy, c.active,
      (SELECT COUNT(*) FROM dosh_analysis d WHERE d.dosh_type = c.code AND d.detected = 1) AS timesDetected,
      (SELECT json_group_array(json_object('pujaId', r.puja_id, 'weight', r.weight, 'priority', r.priority, 'reason', r.reason))
         FROM condition_puja_rules r WHERE r.condition_code = c.code) AS rules
    FROM kundali_conditions c ORDER BY c.severity, c.name`).all();
  res.json({ conditions: rows.map((r) => ({ ...r, rules: j(r.rules, []) })) });
});

router.patch('/kundali/conditions/:code', (req, res) => {
  const c = db.prepare('SELECT * FROM kundali_conditions WHERE code=?').get(req.params.code);
  if (!c) throw notFound('Condition not found');
  const b = req.body || {};
  if (b.name !== undefined) db.prepare('UPDATE kundali_conditions SET name=? WHERE code=?').run(v.str(b.name, 'Name', { max: 60 }), c.code);
  if (b.descr !== undefined) db.prepare('UPDATE kundali_conditions SET descr=? WHERE code=?').run(v.str(b.descr, 'Description', { optional: true, max: 300 }), c.code);
  if (b.remedy !== undefined) db.prepare('UPDATE kundali_conditions SET remedy=? WHERE code=?').run(v.str(b.remedy, 'Remedy', { optional: true, max: 300 }), c.code);
  if (b.severity !== undefined) db.prepare('UPDATE kundali_conditions SET severity=? WHERE code=?').run(v.oneOf(b.severity, ['low', 'medium', 'high'], 'Severity'), c.code);
  if (b.active !== undefined) db.prepare('UPDATE kundali_conditions SET active=? WHERE code=?').run(b.active ? 1 : 0, c.code);
  res.json({ ok: true });
});

/* Add a condition row (the astrological rule itself is code: rules/*.js). */
router.post('/kundali/conditions', (req, res) => {
  const b = req.body || {};
  const code = v.str(b.code, 'Code', { max: 40 }).toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  if (!code) throw bad('Code is required');
  if (db.prepare('SELECT 1 FROM kundali_conditions WHERE code=?').get(code)) throw conflict('That condition code already exists');
  db.prepare('INSERT INTO kundali_conditions(code,name,descr,severity,active) VALUES(?,?,?,?,1)')
    .run(code, v.str(b.name, 'Name', { max: 60 }), v.str(b.descr || '', 'Description', { optional: true, max: 300 }), v.oneOf(b.severity || 'low', ['low', 'medium', 'high'], 'Severity'));
  res.status(201).json({ ok: true, code });
});

router.post('/kundali/rules', (req, res) => {
  const b = req.body || {};
  const code = v.str(b.conditionCode, 'Condition', { max: 40 });
  if (!CONDITION_CODES().includes(code)) throw bad('Unknown condition code');
  const puja = db.prepare('SELECT id FROM pujas WHERE id=?').get(v.str(b.pujaId, 'Puja', { max: 30 }));
  if (!puja) throw bad('Unknown puja');
  const priority = v.oneOf(b.priority || 'secondary', ['primary', 'secondary', 'optional'], 'Priority');
  db.prepare(`INSERT INTO condition_puja_rules(condition_code,puja_id,weight,priority,reason) VALUES(?,?,?,?,?)
              ON CONFLICT(condition_code, puja_id) DO UPDATE SET weight=excluded.weight, priority=excluded.priority, reason=excluded.reason`)
    .run(code, puja.id, v.int(b.weight || 5, 'Weight', { min: 1, max: 100 }), priority, v.str(b.reason || '', 'Reason', { optional: true, max: 300 }));
  res.status(201).json({ ok: true });
});

router.delete('/kundali/rules/:conditionCode/:pujaId', (req, res) => {
  const r = db.prepare('DELETE FROM condition_puja_rules WHERE condition_code=? AND puja_id=?').run(req.params.conditionCode, req.params.pujaId);
  if (!r.changes) throw notFound('Rule not found');
  res.json({ ok: true });
});

/* Recent kundali analyses for the admin overview. */
router.get('/kundali/analyses', (req, res) => {
  const rows = db.prepare(`
    SELECT k.id, k.name, k.lagna, k.rashi, k.nakshatra, k.pada, k.created_at, k.calculation_version,
      (SELECT COUNT(*) FROM dosh_analysis d WHERE d.kundali_id = k.id AND d.detected = 1) AS doshas,
      (SELECT COUNT(*) FROM puja_recommendations pr WHERE pr.kundali_id = k.id) AS recommendations
    FROM kundalis k ORDER BY k.created_at DESC LIMIT 100`).all();
  res.json({ analyses: rows });
});

/* --- demo data management: reset the database or generate mock bookings --- */
const seedMod = require('../seed');

router.get('/demo/stats', (req, res) => res.json(seedMod.demoStats()));

/* Wipes ALL data (bookings, kundalis, users, catalogue...) and re-seeds a fresh
   demo state: admin account, catalogue, demo accounts, sample bookings and mock
   kundalis. The logged-in admin's own account is recreated with the same email,
   but their session token stops working — the response carries a fresh one. */
router.post('/demo/reset', (req, res) => {
  if (req.body && req.body.confirm !== 'RESET') throw bad('Type RESET to confirm');
  const me = db.prepare('SELECT email FROM users WHERE id=?').get(req.auth.uid);
  const adminEmail = me ? me.email : null;
  seedMod.resetAll();
  setSetting('booking_seq', 2400);
  seedMod.bootstrap();
  let token = null;
  try {
    const email = (process.env.ADMIN_EMAIL || adminEmail || 'admin@daivikpuja.in').toLowerCase();
    const u = db.prepare("SELECT * FROM users WHERE role='admin' AND email=?").get(email) || db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get();
    token = u ? sign(u) : null;
  } catch (e) { /* token stays null; the UI falls back to the admin login form */ }
  res.json({ ok: true, stats: seedMod.demoStats(), token });
});

/* Generate mock bookings across the demo customers (demo mode only). */
router.post('/demo/bookings', (req, res) => {
  res.status(201).json(Object.assign({ ok: true }, seedMod.mockBookings(req.body && req.body.count)));
});

/* Demo accounts list for the login modal picker and the admin Demo data tab:
   10 demo customers + the 5 official pandit demo logins. */
router.get('/demo/accounts', (req, res) => {
  const customers = db.prepare("SELECT id, name, mobile, email, plus, pts FROM users WHERE role='customer' AND (mobile LIKE '9811100%' OR mobile='9876543210') ORDER BY id LIMIT 10").all();
  const pd = db.prepare("SELECT p.id, p.name, p.city, p.status, u.mobile FROM pandits p JOIN users u ON u.id=p.user_id WHERE p.mobile LIKE '98100000%' ORDER BY p.id LIMIT 5").all();
  res.json({ customers: customers.map((u) => ({ id: u.id, name: u.name, mobile: u.mobile, email: u.email, plus: !!u.plus, pts: u.pts })), pandits: pd.map((p) => ({ id: p.id, name: p.name, city: p.city, mobile: p.mobile, status: p.status })), password: seedMod.DEMO_PASSWORD });
});

/* --- Customized Puja requests (from POST /api/custom-puja) ---------------- */
router.get('/custom-requests', (req, res) => {
  const rows = db.prepare('SELECT * FROM custom_requests ORDER BY created_at DESC, id DESC LIMIT 200').all();
  res.json({ requests: rows.map((r) => ({ id: r.id, userId: r.user_id, name: r.name, mobile: r.mobile, purpose: r.purpose, deity: r.deity, preferredDate: r.preferred_date, city: r.city, budget: r.budget, notes: r.notes, status: r.status, adminNote: r.admin_note, pujaId: r.puja_id, createdAt: r.created_at })) });
});

router.patch('/custom-requests/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM custom_requests WHERE id=?').get(req.params.id); if (!r) throw notFound('Request not found');
  const status = req.body.status !== undefined ? v.oneOf(req.body.status, ['New', 'Contacted', 'Quoted', 'Booked', 'Closed'], 'Status') : r.status;
  const note = req.body.adminNote !== undefined ? v.str(req.body.adminNote, 'Note', { max: 500, optional: true }) : r.admin_note;
  db.prepare('UPDATE custom_requests SET status=?, admin_note=?, updated_at=datetime(\'now\') WHERE id=?').run(status, note || '', r.id);
  if (req.body.status === 'Booked' && r.user_id) notify(r.user_id, 'WhatsApp', `Your custom puja request ${r.id} is booked. Our team will confirm the details.`);
  res.json({ ok: true });
});

/* Convert an accepted request into a real catalogue puja (hidden until priced). */
router.post('/custom-requests/:id/convert', (req, res) => {
  const r = db.prepare('SELECT * FROM custom_requests WHERE id=?').get(req.params.id); if (!r) throw notFound('Request not found');
  const kit = db.prepare('SELECT id FROM kits WHERE active=1 ORDER BY id LIMIT 1').get();
  if (!kit) throw bad('Create a samagri kit first');
  const id = 'c' + rid(3);
  db.prepare('INSERT INTO pujas(id,name,hindi,cat,icon,dur,price,deity,ben,kit,pop,tags,hidden) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,1)')
    .run(id, v.str(req.body.name || (r.deity ? r.deity + ' Puja' : 'Custom Puja'), 'Name', { max: 80 }),
      v.str(req.body.hindi || r.deity || req.body.name || 'विशेष पूजा', 'Hindi name', { max: 80 }),
      'Life Event', '🕉️', v.int(req.body.dur || 90, 'Duration', { min: 15, max: 720 }),
      v.int(req.body.price || 2500, 'Price', { min: 100, max: 1000000 }),
      v.str(r.deity || 'Custom', 'Deity', { max: 60 }),
      'Customised puja created from request ' + r.id + (r.purpose ? ': ' + r.purpose : '.') + '.', kit.id, String(req.body.name || r.name).toLowerCase());
  db.prepare('UPDATE custom_requests SET status=\'Booked\', puja_id=?, admin_note=?, updated_at=datetime(\'now\') WHERE id=?')
    .run(id, (r.admin_note ? r.admin_note + ' | ' : '') + 'Converted to puja ' + id + '.', r.id);
  if (r.user_id) notify(r.user_id, 'WhatsApp', `Good news! Your custom puja request ${r.id} is now bookable on DaivikPooja.`);
  res.status(201).json({ ok: true, pujaId: id });
});

router.post('/orders/:id/advance', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id); if (!o) throw notFound();
  const s = ['Placed', 'Packed', 'Dispatched', 'Delivered'], nx = s[Math.min(3, s.indexOf(o.status) + 1)];
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(nx, o.id);
  notify(o.user_id, 'SMS', `Order ${o.id} is ${nx.toLowerCase()}.`);
  res.json({ ok: true });
});
router.post('/tickets/:id/resolve', (req, res) => { const r = db.prepare("UPDATE tickets SET status='Resolved' WHERE id=?").run(req.params.id); if (!r.changes) throw notFound(); res.json({ ok: true }); });
module.exports = router;
