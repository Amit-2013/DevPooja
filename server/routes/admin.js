const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const { db, setSetting, nextSeq } = require('../db');
const { requireRole, sign } = require('../auth');
const B = require('../services/bookings');
const S = require('../lib/serialize');
const upload = require('../lib/upload');
const { notify } = require('../services/notify');
const PE = require('../services/payoutEngine');
const { v, bad, conflict, notFound, j, today, rid, wrap } = require('../lib/util');
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
  AUDIT.audit(req.auth.uid, 'pandit.kyc', 'pandit', p.id, { from: p.status, to: st, reason: req.body.reason || null });
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
router.post('/settings', (req, res) => {
  const prev = db.prepare("SELECT value FROM settings WHERE key='commission'").get();
  setSetting('commission', v.int(req.body.commission, 'Commission', { min: 0, max: 60 }));
  AUDIT.audit(req.auth.uid, 'settings.commission', 'settings', 'commission',
    { from: prev ? JSON.parse(prev.value) : null, to: req.body.commission });
  res.json({ ok: true });
});
/* Read + update the engine's default hold set (Phase 7 hold reasons). The engine
   falls back to the same defaults when the setting is absent. */
const HOLD_CHECKS = ['pandit_kyc', 'bank', 'dispute', 'review', 'refund', 'reconciliation', 'admin'];
router.get('/payout-rules', (req, res) => res.json({ holds: PE.payoutRules().holds }));
router.post('/payout-rules', (req, res) => {
  const holds = v.arr(req.body.holds, 'Holds').map((h) => {
    if (!h || typeof h !== 'object') throw bad('Each hold needs reason and check');
    return { reason: v.str(h.reason, 'Reason', { max: 120 }), check: v.oneOf(h.check, HOLD_CHECKS, 'Check') };
  });
  const prev = db.prepare("SELECT value FROM settings WHERE key='payout_holds'").get();
  setSetting('payout_holds', holds);
  AUDIT.audit(req.auth.uid, 'settings.payout_holds', 'settings', 'payout_holds',
    { from: prev ? j(prev.value, null) : null, to: holds });
  res.json({ ok: true, holds });
});
router.post('/coupons', (req, res) => {
  const b = req.body, code = v.str(b.code, 'Code', { max: 20 }).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) throw bad('Code is required');
  if (db.prepare('SELECT 1 FROM coupons WHERE code=?').get(code)) throw conflict('That code already exists');
  const type = v.oneOf(b.type, ['pct', 'flat'], 'Type'), val = v.int(b.val, 'Value', { min: 1, max: type === 'pct' ? 90 : 100000 });
  db.prepare('INSERT INTO coupons(code,type,val,max,min,active,used) VALUES(?,?,?,?,?,1,0)').run(code, type, val, v.int(b.max || val, 'Maximum', { min: 1 }), v.int(b.min || 1000, 'Minimum', { min: 0 }));
  AUDIT.audit(req.auth.uid, 'coupon.create', 'coupon', code, { type, val, max: b.max || val, min: b.min || 1000 });
  res.status(201).json({ ok: true });
});
router.patch('/coupons/:code', (req, res) => {
  const prev = db.prepare('SELECT active FROM coupons WHERE code=?').get(req.params.code); if (!prev) throw notFound();
  db.prepare('UPDATE coupons SET active=? WHERE code=?').run(req.body.active ? 1 : 0, req.params.code);
  AUDIT.audit(req.auth.uid, 'coupon.toggle', 'coupon', req.params.code, { from: !!prev.active, to: !!req.body.active });
  res.json({ ok: true });
});
/* Payout lifecycle goes through the centralized engine (Phases 7-8); the legacy
   direct-'Paid' write is retired. Disbursement requires a payment reference or UTR. */
router.post('/payouts/:id/process', (req, res) => res.json({ payout: S.payout(PE.transition(req.params.id, 'process', req.auth.uid)) }));
router.post('/payouts/:id/hold', (req, res) => res.json({ payout: S.payout(PE.transition(req.params.id, 'hold', req.auth.uid, { reason: req.body.reason, note: req.body.note })) }));
router.post('/payouts/:id/disburse', (req, res) => res.json({ payout: S.payout(PE.transition(req.params.id, 'disburse', req.auth.uid, { paymentRef: req.body.paymentRef, utr: req.body.utr })) }));
router.post('/payouts/:id/fail', (req, res) => res.json({ payout: S.payout(PE.transition(req.params.id, 'fail', req.auth.uid, { reason: req.body.reason })) }));
router.post('/payouts/:id/reverse', (req, res) => res.json({ payout: S.payout(PE.transition(req.params.id, 'reverse', req.auth.uid, { reason: req.body.reason })) }));
router.post('/payouts/:id/adjustment', (req, res) => res.json({ payout: S.payout(PE.setAdjustment(req.params.id, v.int(req.body.amount, 'Adjustment', { min: -10000000, max: 10000000 }), req.auth.uid, req.body.reason)) }));
router.get('/payouts/:id', (req, res) => { const r = PE.get(req.params.id); if (!r) throw notFound(); res.json({ payout: S.payout(r) }); });
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
/* Demo reset re-runs bootstrap(), which re-seeds photos and variants sequentially;
   the response waits for that chain so a client never sees a half-settled media set. */
router.post('/demo/reset', wrap(async (req, res) => {
  if (req.body && req.body.confirm !== 'RESET') throw bad('Type RESET to confirm');
  const me = db.prepare('SELECT email FROM users WHERE id=?').get(req.auth.uid);
  const adminEmail = me ? me.email : null;
  seedMod.resetAll();
  setSetting('booking_seq', 2400);
  seedMod.bootstrap();
  await seedMod.settledMedia();
  let token = null;
  try {
    const email = (process.env.ADMIN_EMAIL || adminEmail || 'admin@daivikpuja.in').toLowerCase();
    const u = db.prepare("SELECT * FROM users WHERE role='admin' AND email=?").get(email) || db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get();
    token = u ? sign(u) : null;
  } catch (e) { /* token stays null; the UI falls back to the admin login form */ }
  res.json({ ok: true, stats: seedMod.demoStats(), token });
}));

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

/* --- Customized Puja requests (from POST /api/custom-puja) ----------------
   Full workflow (migration 008): NEW -> UNDER_REVIEW -> PANDIT_CONSULTATION ->
   QUOTE_PREPARED -> CUSTOMER_APPROVAL_PENDING -> APPROVED -> PAYMENT_PENDING ->
   PAID -> PANDIT_ASSIGNED -> TEMPLE_ASSIGNED -> SCHEDULED -> IN_PROGRESS ->
   COMPLETED | REJECTED | CANCELLED | EXPIRED | REFUNDED. History is tracked. */
const CR_STATUSES = ['NEW', 'UNDER_REVIEW', 'PANDIT_CONSULTATION', 'QUOTE_PREPARED', 'CUSTOMER_APPROVAL_PENDING', 'APPROVED', 'PAYMENT_PENDING', 'PAID', 'PANDIT_ASSIGNED', 'TEMPLE_ASSIGNED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'REFUNDED'];
const crOut = (r) => ({ id: r.id, userId: r.user_id, name: r.name, mobile: r.mobile, language: r.language, requirement: r.requirement, purpose: r.purpose, deity: r.deity, occasion: r.occasion, preferredDate: r.preferred_date, preferredTime: r.preferred_time, location: r.location, city: r.city, state: r.state, country: r.country, participants: r.participants, budget: r.budget, kundaliId: r.kundali_id, doshCondition: r.dosh_condition, remedy: r.remedy, sankalp: r.sankalp, samagriReq: r.samagri_req, notes: r.notes, attachments: j(r.attachments, []), status: r.status, adminNotes: r.admin_notes, panditNotes: r.pandit_notes, quoteAmount: r.quote_amount, finalPrice: r.final_price, paymentStatus: r.payment_status, assignedPanditId: r.assigned_pandit_id, assignedTempleId: r.assigned_temple_id, bookingId: r.booking_id, pujaId: r.puja_id, history: j(r.history, []), createdAt: r.created_at, updatedAt: r.updated_at });
const crHistory = (r, entry) => JSON.stringify([...j(r.history, []), [entry, new Date().toISOString().slice(0, 16).replace('T', ' ')]]);

router.get('/custom-requests', (req, res) => {
  const f = [];
  let sql = 'SELECT * FROM custom_requests';
  if (req.query.status) { f.push(String(req.query.status)); sql += ' WHERE status=?'; }
  sql += ' ORDER BY created_at DESC, id DESC LIMIT 500';
  const rows = f.length ? db.prepare(sql).all(...f) : db.prepare(sql).all();
  res.json({ requests: rows.map(crOut) });
});

router.patch('/custom-requests/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM custom_requests WHERE id=?').get(req.params.id); if (!r) throw notFound('Request not found');
  const b = req.body || {};
  const status = b.status !== undefined ? v.oneOf(b.status, CR_STATUSES, 'Status') : r.status;
  const sets = { status, admin_notes: b.adminNotes !== undefined ? v.str(b.adminNotes, 'Note', { max: 800, optional: true }) : r.admin_notes,
    pandit_notes: b.panditNotes !== undefined ? v.str(b.panditNotes, 'Pandit note', { max: 800, optional: true }) : r.pandit_notes,
    quote_amount: b.quoteAmount !== undefined ? v.int(b.quoteAmount, 'Quote', { min: 0, max: 10000000 }) : r.quote_amount,
    final_price: b.finalPrice !== undefined ? v.int(b.finalPrice, 'Final price', { min: 0, max: 10000000 }) : r.final_price,
    payment_status: b.paymentStatus !== undefined ? v.oneOf(b.paymentStatus, ['Unpaid', 'Paid', 'Refunded'], 'Payment status') : r.payment_status,
    assigned_pandit_id: b.assignedPanditId !== undefined ? String(b.assignedPanditId || '').slice(0, 20) || null : r.assigned_pandit_id,
    assigned_temple_id: b.assignedTempleId !== undefined ? String(b.assignedTempleId || '').slice(0, 20) || null : r.assigned_temple_id };
  if (sets.assigned_pandit_id && !db.prepare('SELECT 1 FROM pandits WHERE id=?').get(sets.assigned_pandit_id)) throw bad('Unknown pandit');
  if (sets.assigned_temple_id && !db.prepare('SELECT 1 FROM temples WHERE id=?').get(sets.assigned_temple_id)) throw bad('Unknown temple');
  const hist = status !== r.status ? crHistory(r, 'Status: ' + r.status + ' -> ' + status + ' (admin)') : null;
  db.prepare(`UPDATE custom_requests SET status=?, admin_notes=?, pandit_notes=?, quote_amount=?, final_price=?, payment_status=?, assigned_pandit_id=?, assigned_temple_id=?, history=?, updated_at=datetime('now') WHERE id=?`)
    .run(sets.status, sets.admin_notes || '', sets.pandit_notes || '', sets.quote_amount, sets.final_price, sets.payment_status || '', sets.assigned_pandit_id, sets.assigned_temple_id, hist || r.history, r.id);
  if (status !== r.status && r.user_id) notify(r.user_id, 'WhatsApp', `Update on your custom puja request ${r.id}: ${status.replaceAll('_', ' ').toLowerCase()}.`);
  res.json({ ok: true });
});

/* Convert an approved request into a real catalogue puja (hidden until priced). */
router.post('/custom-requests/:id/convert', (req, res) => {
  const r = db.prepare('SELECT * FROM custom_requests WHERE id=?').get(req.params.id); if (!r) throw notFound('Request not found');
  const kit = db.prepare('SELECT id FROM kits WHERE active=1 ORDER BY id LIMIT 1').get();
  if (!kit) throw bad('Create a samagri kit first');
  const id = 'c' + rid(3);
  db.prepare('INSERT INTO pujas(id,name,hindi,cat,icon,dur,price,deity,ben,kit,pop,tags,hidden) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,1)')
    .run(id, v.str(req.body.name || (r.deity ? r.deity + ' Puja' : 'Custom Puja'), 'Name', { max: 80 }),
      v.str(req.body.hindi || r.deity || req.body.name || 'विशेष पूजा', 'Hindi name', { max: 80 }),
      'Life Event', '🕉️', v.int(req.body.dur || 90, 'Duration', { min: 15, max: 720 }),
      v.int(req.body.price || r.quote_amount || 2500, 'Price', { min: 100, max: 1000000 }),
      v.str(r.deity || 'Custom', 'Deity', { max: 60 }),
      'Customised puja created from request ' + r.id + (r.purpose ? ': ' + r.purpose : '.') + '.', kit.id, String(req.body.name || r.name).toLowerCase());
  db.prepare(`UPDATE custom_requests SET status='SCHEDULED', puja_id=?, history=?, admin_notes=?, updated_at=datetime('now') WHERE id=?`)
    .run(id, crHistory(r, 'Converted to puja ' + id + ' (admin)'), (r.admin_notes ? r.admin_notes + ' | ' : '') + 'Converted to puja ' + id + '.', r.id);
  if (r.user_id) notify(r.user_id, 'WhatsApp', `Good news! Your custom puja request ${r.id} is now bookable on DaivikPooja.`);
  res.status(201).json({ ok: true, pujaId: id });
});

/* --- Kundali management: pricing, toggles, list --------------------------- */
const KB = require('../services/kundaliBilling');
const TOGGLE_KEYS = ['home', 'online', 'temple', 'customized', 'kundali', 'pandit', 'templeDir', 'prasad', 'samagri', 'astrology'];

router.get('/kundali/pricing', (req, res) => res.json({ pricing: KB.pricing() }));
router.put('/kundali/pricing', (req, res) => {
  const b = req.body || {};
  const p = KB.pricing();
  const next = {
    active: b.active !== undefined ? !!b.active : p.active,
    currency: b.currency !== undefined ? v.oneOf(b.currency, ['INR', 'USD'], 'Currency') : p.currency,
    personalPrice: b.personalPrice !== undefined ? v.int(b.personalPrice, 'Personal price', { min: 0, max: 1000000 }) : p.personalPrice,
    familyPrice: b.familyPrice !== undefined ? v.int(b.familyPrice, 'Family price', { min: 0, max: 1000000 }) : p.familyPrice,
    additionalPrice: b.additionalPrice !== undefined ? v.int(b.additionalPrice, 'Additional price', { min: 0, max: 1000000 }) : p.additionalPrice,
    gstPct: b.gstPct !== undefined ? v.int(b.gstPct, 'GST %', { min: 0, max: 28 }) : p.gstPct,
    discountPct: b.discountPct !== undefined ? v.int(b.discountPct, 'Discount %', { min: 0, max: 90 }) : p.discountPct,
    couponEligible: b.couponEligible !== undefined ? !!b.couponEligible : p.couponEligible,
    freeCounts: {
      customer: b.freeCounts && b.freeCounts.customer !== undefined ? v.int(b.freeCounts.customer, 'Free count (customer)', { min: 0, max: 100 }) : p.freeCounts.customer,
      plus: b.freeCounts && b.freeCounts.plus !== undefined ? v.int(b.freeCounts.plus, 'Free count (plus)', { min: 0, max: 100 }) : p.freeCounts.plus,
      premium: b.freeCounts && b.freeCounts.premium !== undefined ? v.int(b.freeCounts.premium, 'Free count (premium)', { min: 0, max: 100 }) : p.freeCounts.premium
    }
  };
  setSetting('kundali_pricing', next);
  res.json({ ok: true, pricing: next });
});

router.get('/service-toggles', (req, res) => res.json({ toggles: getSettingToggles() }));
router.put('/service-toggles', (req, res) => {
  const cur = getSettingToggles();
  for (const k of TOGGLE_KEYS) if (req.body[k] !== undefined) cur[k] = !!req.body[k];
  setSetting('service_toggles', cur);
  res.json({ ok: true, toggles: cur });
});

function getSettingToggles() {
  const r = db.prepare("SELECT value FROM settings WHERE key='service_toggles'").get();
  const def = Object.fromEntries(TOGGLE_KEYS.map((k) => [k, true]));
  try { return Object.assign(def, r ? JSON.parse(r.value) : {}); } catch (e) { return def; }
}

/* Admin kundali list with filters (matches the Reports export source). */
router.get('/kundalis', (req, res) => {
  const w = [], a = [];
  let sql = 'SELECT k.*, u.name AS customer_name, u.mobile AS customer_mobile FROM kundalis k LEFT JOIN users u ON u.id=k.customer_id';
  if (req.query.billing) { w.push('k.billing=?'); a.push(String(req.query.billing)); }
  if (req.query.kind === 'family') w.push("k.relationship != ''");
  if (req.query.kind === 'personal') w.push("(k.relationship = '' OR k.relationship IS NULL)");
  if (req.query.q) { w.push('(k.name LIKE ? OR k.id LIKE ? OR u.name LIKE ? OR u.mobile LIKE ? OR k.order_id LIKE ?)'); const like = '%' + String(req.query.q).replace(/[%_]/g, '') + '%'; a.push(like, like, like, like, like); }
  if (w.length) sql += ' WHERE ' + w.join(' AND ');
  sql += ' ORDER BY k.created_at DESC LIMIT 500';
  const rows = db.prepare(sql).all(...a);
  res.json({ kundalis: rows.map((k) => ({ kundaliId: k.id, name: k.name, customer: k.customer_name || '', mobile: k.customer_mobile || '', relationship: k.relationship || 'Self', billing: k.billing, price: k.price, discount: k.discount, gst: k.gst, final: k.final_amount, currency: k.currency, paymentStatus: k.payment_status, orderId: k.order_id, paymentId: k.payment_id, createdAt: k.created_at })) });
});

/* --- Reports: Excel (.xlsx) exports -----------------------------------------
   One route, many report ids. Each report is a function returning {columns, rows}
   built from the SAME queries the admin pages use (single source of truth), with
   sensitive fields (password hashes, OTPs, tokens, KYC) excluded by design.
   Filters come from the query string and are applied inside the report functions.
   Every export is written to export_logs (admin, report, filters, row count). */
const REPORTS = {
  customers: (f) => select('SELECT id, name, mobile, email, plus, pts, joined FROM users WHERE role=\'customer\' ORDER BY id', [],
    ['ID', 'Name', 'Mobile', 'Email', 'Plus member', 'Points', 'Joined']),
  pandits: (f) => select('SELECT p.id, p.name, p.city, p.exp, p.rating, p.rev, p.status, p.featured, u.mobile FROM pandits p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.id', [],
    ['ID', 'Name', 'City', 'Experience (yrs)', 'Rating', 'Reviews', 'KYC status', 'Featured', 'Mobile']),
  temples: (f) => select('SELECT id, name, city, deity, offering, descr FROM temples ORDER BY id', [],
    ['ID', 'Name', 'City', 'Deity', 'Offering (Rs)', 'Description']),
  pujas: (f) => select('SELECT id, name, hindi, cat, price, dur, deity, hidden, pop FROM pujas ORDER BY id', [],
    ['ID', 'Name', 'Hindi name', 'Category', 'Price (Rs)', 'Duration (min)', 'Deity', 'Hidden', 'Popularity']),
  bookings: (f) => {
    const { where, args } = bookingFilter(f);
    return select('SELECT b.id, b.user_id, u.name AS customer, u.mobile, b.puja_id, b.mode, b.date, b.slot, b.status, json_extract(b.q,\'$.total\') AS total, b.coupon FROM bookings b LEFT JOIN users u ON u.id=b.user_id' + where + ' ORDER BY b.created DESC', args,
      ['Booking ID', 'Customer', 'Mobile', 'Puja', 'Mode', 'Date', 'Slot', 'Status', 'Total (Rs)', 'Coupon']);
  },
  payments: (f) => {
    const { where, args } = bookingFilter(f);
    const w2 = where + (where ? ' AND ' : ' WHERE ') + "json_extract(b.pay,'$.paid')=1";
    return select("SELECT b.id, u.name AS customer, b.puja_id, b.date, json_extract(b.pay,'$.method') AS method, json_extract(b.pay,'$.ref') AS ref, json_extract(b.q,'$.total') AS total, b.status FROM bookings b LEFT JOIN users u ON u.id=b.user_id" + w2 + ' ORDER BY b.created DESC', args,
      ['Booking ID', 'Customer', 'Puja', 'Date', 'Method', 'Reference', 'Amount (Rs)', 'Booking status']);
  },
  orders: (f) => select('SELECT o.id, u.name AS customer, o.total, o.date, o.status, o.city FROM orders o LEFT JOIN users u ON u.id=o.user_id ORDER BY o.date DESC', [],
    ['Order ID', 'Customer', 'Total (Rs)', 'Date', 'Status', 'City']),
  kundalis: (f) => {
    const { where, args } = kundaliFilter(f);
    return select('SELECT k.id, k.name, u.name AS customer, u.mobile, k.relationship, k.billing, k.price, k.discount, k.gst, k.final_amount, k.currency, k.payment_status, k.order_id, k.created_at FROM kundalis k LEFT JOIN users u ON u.id=k.customer_id' + where + ' ORDER BY k.created_at DESC', args,
      ['Kundali ID', 'Name', 'Customer', 'Mobile', 'Relationship', 'Billing', 'Price (Rs)', 'Discount (Rs)', 'GST (Rs)', 'Final (Rs)', 'Currency', 'Payment status', 'Order ID', 'Created']);
  },
  'kundali-payments': (f) => {
    const { where, args } = kundaliFilter(f);
    return select("SELECT k.id, u.name AS customer, k.final_amount, k.currency, k.payment_status, k.order_id, k.payment_id, k.created_at FROM kundalis k LEFT JOIN users u ON u.id=k.customer_id" + where + (where ? ' AND ' : ' WHERE ') + "k.billing IN ('PAID','PENDING_PAYMENT','REFUNDED') ORDER BY k.created_at DESC", args,
      ['Kundali ID', 'Customer', 'Amount (Rs)', 'Currency', 'Payment status', 'Order ID', 'Payment ID', 'Created']);
  },
  'family-members': (f) => select('SELECT f.id, u.name AS customer, f.relationship, f.name, f.gender, f.dob, f.tob, f.city, f.state, f.country FROM family_members f LEFT JOIN users u ON u.id=f.customer_id ORDER BY f.created_at', [],
    ['Member ID', 'Customer', 'Relationship', 'Name', 'Gender', 'DOB', 'TOB', 'City', 'State', 'Country']),
  'custom-requests': (f) => {
    const w = [], a = [];
    let sql = 'SELECT c.id, c.name, c.mobile, c.purpose, c.deity, c.occasion, c.preferred_date, c.city, c.budget, c.kundali_id, c.dosh_condition, c.assigned_pandit_id, c.quote_amount, c.final_price, c.payment_status, c.status, c.created_at, c.updated_at FROM custom_requests c';
    if (f.status) { w.push('c.status=?'); a.push(String(f.status)); }
    if (f.q) { w.push('(c.name LIKE ? OR c.mobile LIKE ? OR c.id LIKE ?)'); const like = '%' + String(f.q).replace(/[%_]/g, '') + '%'; a.push(like, like, like); }
    if (w.length) sql += ' WHERE ' + w.join(' AND ');
    sql += ' ORDER BY c.created_at DESC';
    return select(sql, a,
      ['Request ID', 'Name', 'Mobile', 'Purpose', 'Deity', 'Occasion', 'Preferred date', 'City', 'Budget (Rs)', 'Kundali ID', 'Dosh', 'Assigned pandit', 'Quote (Rs)', 'Final price (Rs)', 'Payment status', 'Status', 'Created', 'Updated']);
  },
  samagri: (f) => select('SELECT id, name, price, stock, active FROM kits ORDER BY id', [],
    ['Kit ID', 'Name', 'Price (Rs)', 'Stock', 'Active']),
  prasad: (f) => select('SELECT id, name, price, stock, active FROM prasad ORDER BY id', [],
    ['ID', 'Name', 'Price (Rs)', 'Stock', 'Active']),
  coupons: (f) => select('SELECT code, type, val, max, min, active, used FROM coupons ORDER BY code', [],
    ['Code', 'Type', 'Value', 'Max (Rs)', 'Min order (Rs)', 'Active', 'Times used']),
  campaigns: (f) => select('SELECT id, name, channel, audience, status, sent FROM campaigns ORDER BY id', [],
    ['ID', 'Name', 'Channel', 'Audience', 'Status', 'Sent']),
  payouts: (f) => select('SELECT po.id, p.name AS pandit, po.amount, po.date, po.status, po.booking_id, po.gross_amount, po.commission_amt, po.tax_amt, po.refund_amt, po.adjustment_amt, po.hold_reason, po.processing_date, po.disbursement_date, po.payment_ref, po.utr FROM payouts po LEFT JOIN pandits p ON p.id=po.pandit_id ORDER BY po.date DESC', [],
    ['Payout ID', 'Pandit', 'Net (Rs)', 'Date', 'Status', 'Booking ID', 'Gross (Rs)', 'Commission (Rs)', 'Tax (Rs)', 'Refund (Rs)', 'Adjustment (Rs)', 'Hold reason', 'Processing date', 'Disbursement date', 'Payment ref', 'UTR']),
  'payout-audit': (f) => select('SELECT po.id, po.pandit_id, po.amount, po.status, po.hold_reason, po.hold_note, po.processing_date, po.disbursement_date, po.payment_ref, po.utr FROM payouts po ORDER BY po.date DESC', [],
    ['Payout ID', 'Pandit ID', 'Net (Rs)', 'Status', 'Hold reason', 'Hold note', 'Processing date', 'Disbursement date', 'Payment ref', 'UTR']),
  revenue: (f) => {
    const rows = db.prepare("SELECT substr(b.date,1,7) ym, COUNT(*) n, SUM(CAST(json_extract(b.q,'$.total') AS INTEGER)) amt FROM bookings b WHERE json_extract(b.pay,'$.paid')=1 GROUP BY ym ORDER BY ym DESC").all();
    return { columns: ['Month', 'Paid bookings', 'Revenue (Rs)'], rows: rows.map((r) => [r.ym, r.n, r.amt || 0]) };
  },
  'puja-performance': (f) => {
    const rows = db.prepare("SELECT p.name, b.mode, COUNT(*) n, SUM(CAST(json_extract(b.q,'$.total') AS INTEGER)) amt FROM bookings b JOIN pujas p ON p.id=b.puja_id WHERE b.status != 'Cancelled' GROUP BY b.puja_id, b.mode ORDER BY amt DESC").all();
    return { columns: ['Puja', 'Mode', 'Bookings', 'Value (Rs)'], rows: rows.map((r) => [r.name, r.mode, r.n, r.amt || 0]) };
  },
  commission: (f) => {
    const comm = db.prepare("SELECT value FROM settings WHERE key='commission'").get();
    const pct = comm ? JSON.parse(comm.value) : 20;
    const rows = db.prepare("SELECT substr(b.date,1,7) ym, SUM(CAST(json_extract(b.q,'$.total') AS INTEGER)) amt FROM bookings b WHERE json_extract(b.pay,'$.paid')=1 AND b.status != 'Cancelled' GROUP BY ym ORDER BY ym DESC").all();
    return { columns: ['Month', 'Platform commission (Rs)'], rows: rows.map((r) => [r.ym, Math.round((r.amt || 0) * pct / 100)]) };
  },
  /* --- account management, media and audit reports (migration 009) --- */
  'customer-accounts': () => select(`SELECT u.id, u.name, COALESCE(u.mobile,'') mobile, COALESCE(u.email,'') email,
    CASE WHEN u.email IS NOT NULL AND u.email != '' THEN u.email ELSE COALESCE(u.mobile,'') END loginId,
    CASE WHEN u.email IS NOT NULL AND u.email != '' THEN 'email' ELSE 'mobile' END loginMethod,
    COALESCE(u.status,'active') status, COALESCE(u.joined,'') joined,
    CASE WHEN u.last_login_at THEN datetime(u.last_login_at/1000,'unixepoch') ELSE '' END lastLogin,
    COALESCE(u.last_login_method,'') lastMethod,
    (SELECT COUNT(*) FROM bookings b WHERE b.user_id=u.id) bookings,
    (SELECT COUNT(*) FROM kundalis k WHERE k.customer_id=u.id) kundalis,
    (SELECT COUNT(*) FROM family_members f WHERE f.customer_id=u.id) family
    FROM users u WHERE u.role='customer' ORDER BY u.created_at DESC`, [],
    ['ID', 'Name', 'Mobile', 'Email', 'Login ID', 'Login method', 'Status', 'Joined', 'Last login', 'Last method', 'Bookings', 'Kundalis', 'Family members']),
  'pandit-accounts': () => select(`SELECT p.id, p.name, COALESCE(NULLIF(p.mobile,''), COALESCE(u.mobile,'')) mobile, COALESCE(u.email,'') email,
    CASE WHEN p.status='verified' THEN 'Yes' ELSE 'No' END kycVerified, COALESCE(u.status,'active') status, COALESCE(u.joined,'') joined,
    CASE WHEN u.last_login_at THEN datetime(u.last_login_at/1000,'unixepoch') ELSE '' END lastLogin,
    (SELECT COUNT(*) FROM bookings b WHERE b.pandit_id=p.id) assigned,
    (SELECT COUNT(*) FROM bookings b WHERE b.pandit_id=p.id AND b.status='Completed') completed
    FROM pandits p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.id`, [],
    ['Pandit ID', 'Name', 'Mobile (login ID)', 'Email', 'KYC verified', 'Account status', 'Joined', 'Last login', 'Assigned bookings', 'Completed']),
  'refunds': (f) => {
    const { where, args } = bookingFilter(f);
    return select("SELECT b.id, u.name AS customer, b.puja_id, b.date, json_extract(b.refund,'$.amt') AS amt, json_extract(b.refund,'$.state') AS state, json_extract(b.refund,'$.reason') AS reason FROM bookings b LEFT JOIN users u ON u.id=b.user_id" + where + (where ? ' AND ' : ' WHERE ') + 'b.refund IS NOT NULL ORDER BY b.created DESC', args,
      ['Booking', 'Customer', 'Puja', 'Date', 'Amount (Rs)', 'State', 'Reason']);
  },
  'pandit-performance': () => select(`SELECT p.name, p.city, p.rating,
    (SELECT COUNT(*) FROM bookings b WHERE b.pandit_id=p.id) assigned,
    (SELECT COUNT(*) FROM bookings b WHERE b.pandit_id=p.id AND b.status='Completed') completed,
    (SELECT COALESCE(SUM(CAST(json_extract(b.q,'$.svc') AS INTEGER)),0) FROM bookings b WHERE b.pandit_id=p.id AND b.status='Completed') serviceValue
    FROM pandits p ORDER BY p.name`, [],
    ['Pandit', 'City', 'Rating', 'Assigned', 'Completed', 'Service value (Rs)']),
  'customer-activity': () => select(`SELECT u.id, u.name, COALESCE(u.mobile,'') mobile,
    (SELECT COUNT(*) FROM bookings b WHERE b.user_id=u.id) bookings,
    (SELECT COALESCE(SUM(CAST(json_extract(b.q,'$.total') AS INTEGER)),0) FROM bookings b WHERE b.user_id=u.id) spent,
    (SELECT COALESCE(MAX(b.date),'') FROM bookings b WHERE b.user_id=u.id) lastBooking,
    (SELECT COUNT(*) FROM kundalis k WHERE k.customer_id=u.id) kundalis
    FROM users u WHERE u.role='customer' ORDER BY 5 DESC`, [],
    ['Customer ID', 'Name', 'Mobile', 'Bookings', 'Total spent (Rs)', 'Last booking', 'Kundalis']),
  'login-activity': (f) => {
    const w = [], a = [];
    if (f.status === 'failed') w.push('l.ok=0');
    if (f.status === 'success') w.push('l.ok=1');
    if (f.from) { w.push("datetime(l.ts/1000,'unixepoch')>=?"); a.push(String(f.from) + ' 00:00:00'); }
    if (f.to) { w.push("datetime(l.ts/1000,'unixepoch')<=?"); a.push(String(f.to) + ' 23:59:59'); }
    return select("SELECT u.name, u.role, l.method, CASE WHEN l.ok=1 THEN 'Success' ELSE 'Failed' END outcome, l.reason, l.ip, datetime(l.ts/1000,'unixepoch') ts FROM login_activity l LEFT JOIN users u ON u.id=l.user_id" + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY l.ts DESC LIMIT 2000', a,
      ['User', 'Role', 'Method', 'Outcome', 'Reason', 'IP', 'When']);
  },
  'audit-logs': (f) => {
    const w = [], a = [];
    if (f.action) { w.push('a.action=?'); a.push(String(f.action)); }
    if (f.from) { w.push("datetime(a.created_at/1000,'unixepoch')>=?"); a.push(String(f.from) + ' 00:00:00'); }
    if (f.to) { w.push("datetime(a.created_at/1000,'unixepoch')<=?"); a.push(String(f.to) + ' 23:59:59'); }
    return select("SELECT datetime(a.created_at/1000,'unixepoch') ts, COALESCE(u.name, a.actor_user_id) actor, a.actor_role, a.action, a.entity, a.entity_id, a.detail FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id" + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY a.id DESC LIMIT 2000', a,
      ['When', 'Actor', 'Role', 'Action', 'Entity', 'Entity ID', 'Detail']);
  },
  media: (f) => {
    const w = [], a = [];
    let sql = 'SELECT m.id, p.name AS puja, m.booking_id, pd.name AS pandit, m.orig_name, m.mime, m.size, m.status, CASE WHEN m.is_primary=1 THEN 1 ELSE 0 END AS is_primary, CASE WHEN m.is_published=1 THEN 1 ELSE 0 END AS is_published, datetime(m.created_at/1000,\'unixepoch\') AS uploaded FROM puja_media m LEFT JOIN pujas p ON p.id=m.puja_id LEFT JOIN pandits pd ON pd.id=m.pandit_id';
    if (f.status) { w.push('m.status=?'); a.push(String(f.status)); }
    if (w.length) sql += ' WHERE ' + w.join(' AND ');
    sql += ' ORDER BY m.created_at DESC';
    return select(sql, a, ['Media ID', 'Puja', 'Booking', 'Pandit', 'Original name', 'MIME', 'Size (bytes)', 'Status', 'Primary', 'Published', 'Uploaded']);
  }
};

function select(sql, args, columns) {
  return { columns, rows: db.prepare(sql).all(...args).map((r) => Object.values(r)) };
}
function bookingFilter(f) {
  const w = ["b.status != 'PendingPayment'"], a = [];
  if (f.status) { w.push('b.status=?'); a.push(String(f.status)); }
  if (f.from) { w.push('b.date>=?'); a.push(String(f.from)); }
  if (f.to) { w.push('b.date<=?'); a.push(String(f.to)); }
  if (f.mode) { w.push('b.mode=?'); a.push(String(f.mode)); }
  return { where: w.length ? ' WHERE ' + w.join(' AND ') : '', args: a };
}
function kundaliFilter(f) {
  const w = [], a = [];
  if (f.billing) { w.push('k.billing=?'); a.push(String(f.billing)); }
  if (f.from) { w.push("substr(k.created_at,1,10)>=?"); a.push(String(f.from)); }
  if (f.to) { w.push("substr(k.created_at,1,10)<=?"); a.push(String(f.to)); }
  return { where: w.length ? ' WHERE ' + w.join(' AND ') : '', args: a };
}

/* Friendly titles for the export header row. */
const REPORT_TITLES = {
  customers: 'Customer', 'customer-accounts': 'Customer Login / Account', 'pandit-accounts': 'Pandit Login / Account',
  pandits: 'Pandit', temples: 'Temple', pujas: 'Puja', bookings: 'Puja Booking', 'custom-requests': 'Customized Puja Request',
  kundalis: 'Kundali', 'kundali-payments': 'Kundali Payment', 'family-members': 'Family Member', samagri: 'Samagri Kit',
  prasad: 'Prasad', orders: 'Order', payments: 'Payment', refunds: 'Refund', coupons: 'Coupon', campaigns: 'Campaign',
  payouts: 'Pandit Payout', 'payout-audit': 'Payout Ledger (holds, refs, UTR)', revenue: 'Revenue by Month', commission: 'Commission by Month', 'puja-performance': 'Puja Performance',
  'pandit-performance': 'Pandit Performance', 'customer-activity': 'Customer Activity', 'login-activity': 'Login Activity',
  'audit-logs': 'Audit Log', media: 'Puja Media'
};

/* GET /admin/export/:report.xlsx — professional format: report title, generated-on
   (IST), applied filters, frozen + filterable header row, auto column widths,
   Indian-currency number formats, a totals row where useful — and an export_logs
   audit entry (admin, report, filters, row count). Sensitive fields stay excluded
   by design: the REPORTS queries never select password hashes, tokens or OTPs. */
router.get('/export/:report.xlsx', wrap(async (req, res) => {
  const rep = REPORTS[req.params.report];
  if (!rep) throw notFound('Unknown report');
  const data = rep(req.query);
  const wb = new (require('exceljs').Workbook)();
  const ws = wb.addWorksheet(String(req.params.report).slice(0, 28), { views: [{ state: 'frozen', ySplit: 4 }] });
  const ncols = Math.max(data.columns.length, 1);
  const filters = Object.entries(req.query).filter(([, v]) => v).map(([k, v]) => k + ': ' + v).join('; ') || 'None';

  ws.mergeCells(1, 1, 1, ncols);
  const t1 = ws.getCell(1, 1);
  t1.value = 'DaivikPooja \u2014 ' + (REPORT_TITLES[req.params.report] || req.params.report) + ' Report';
  t1.font = { bold: true, size: 14, color: { argb: 'FF0C4B49' } };
  ws.mergeCells(2, 1, 2, ncols);
  const t2 = ws.getCell(2, 1);
  t2.value = 'Generated on: ' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true }) + ' IST    |    Rows: ' + data.rows.length;
  t2.font = { size: 10, color: { argb: 'FF6B7280' } };
  ws.mergeCells(3, 1, 3, ncols);
  const t3 = ws.getCell(3, 1);
  t3.value = 'Filters: ' + filters;
  t3.font = { size: 10, italic: true, color: { argb: 'FF6B7280' } };

  const hr = ws.getRow(4);
  hr.values = data.columns;
  hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0C4B49' } };
  hr.alignment = { vertical: 'middle', wrapText: true };
  hr.height = 20;

  const money = /rs|amount|price|total|gst|spent|value|revenue|commission|earning|payout|refund|budget|quote|offering/i;
  const isNum = data.columns.map((h) => money.test(h));
  for (const r of data.rows) {
    const row = ws.addRow(r);
    r.forEach((cell, i) => { if (isNum[i] && typeof cell === 'number') row.getCell(i + 1).numFmt = '#,##0'; });
  }

  if (data.rows.length > 2) {
    const totals = data.columns.map((h, i) => {
      if (!isNum[i]) return i === 0 ? 'Total' : '';
      return data.rows.reduce((a, r) => a + (typeof r[i] === 'number' ? r[i] : 0), 0) || '';
    });
    const tr = ws.addRow(totals);
    tr.font = { bold: true };
    tr.eachCell((c, cn) => { if (isNum[cn - 1] && typeof c.value === 'number') c.numFmt = '#,##0'; });
  }

  data.columns.forEach((h, i) => {
    let w = String(h || '').length + 2;
    for (const r of data.rows) w = Math.max(w, String(r[i] == null ? '' : r[i]).length + 2);
    ws.getColumn(i + 1).width = Math.min(42, Math.max(10, w));
  });

  if (ncols > 1 && data.rows.length) ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: ncols } };

  db.prepare('INSERT INTO export_logs(admin_id,report,filters,rows,ts) VALUES(?,?,?,?,?)')
    .run(req.auth.uid, req.params.report, JSON.stringify(req.query), data.rows.length, Date.now());
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="daivikpooja-' + req.params.report + '-' + new Date().toISOString().slice(0, 10) + '.xlsx"');
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
}));

router.get('/export-logs', (req, res) => {
  const rows = db.prepare('SELECT e.*, u.name AS admin FROM export_logs e LEFT JOIN users u ON u.id=e.admin_id ORDER BY e.ts DESC LIMIT 100').all();
  res.json({ logs: rows.map((r) => ({ id: r.id, admin: r.admin || r.admin_id, report: r.report, filters: r.filters, rows: r.rows, ts: r.ts })) });
});

router.post('/orders/:id/advance', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id); if (!o) throw notFound();
  const s = ['Placed', 'Packed', 'Dispatched', 'Delivered'], nx = s[Math.min(3, s.indexOf(o.status) + 1)];
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(nx, o.id);
  notify(o.user_id, 'SMS', `Order ${o.id} is ${nx.toLowerCase()}.`);
  res.json({ ok: true });
});
router.post('/tickets/:id/resolve', (req, res) => { const r = db.prepare("UPDATE tickets SET status='Resolved' WHERE id=?").run(req.params.id); if (!r.changes) throw notFound(); res.json({ ok: true }); });

/* --- Account management: customers & pandits (login id, status, passwords) --- */
const AUDIT = require('../lib/audit');
const AUTH = require('./auth');
const bcrypt = require('bcryptjs');
const ACCOUNT_STATUSES = ['active', 'suspended', 'disabled'];

/* Customer/pandit account rows with login id, method, verification and counts. */
router.get('/accounts/:role', (req, res) => {
  const role = v.oneOf(req.params.role, ['customer', 'pandit'], 'Role');
  const q = String(req.query.q || '').trim().toLowerCase();
  let rows;
  if (role === 'customer') {
    rows = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM bookings b WHERE b.user_id=u.id) nBookings,
      (SELECT COUNT(*) FROM kundalis k WHERE k.customer_id=u.id) nKundalis,
      (SELECT COUNT(*) FROM family_members f WHERE f.customer_id=u.id) nFamily
      FROM users u WHERE u.role='customer' ORDER BY u.created_at DESC`).all();
    rows = rows.map((u) => ({ id: u.id, name: u.name, loginId: u.email || u.mobile || u.id, loginMethod: u.email ? 'email' : 'mobile', mobile: u.mobile || '', email: u.email || '',
      status: u.status || 'active', joined: u.joined, createdAt: u.created_at, lastLoginAt: u.last_login_at, lastLoginMethod: u.last_login_method || '',
      verified: !!u.pass_hash || !!u.mobile, forceChange: !!u.force_change, demo: /^9811100\d{3}$/.test(u.mobile || '') || u.mobile === '9876543210',
      bookings: u.nBookings, kundalis: u.nKundalis, family: u.nFamily }));
  } else {
    rows = db.prepare(`SELECT u.*, p.id pid, p.name pname, p.city, p.status kyc, p.mobile pmobile,
      (SELECT COUNT(*) FROM bookings b WHERE b.pandit_id=p.id) nAssigned,
      (SELECT COUNT(*) FROM bookings b WHERE b.pandit_id=p.id AND b.status='Completed') nDone
      FROM pandits p JOIN users u ON u.id=p.user_id ORDER BY p.id`).all();
    rows = rows.map((u) => ({ id: u.id, panditId: u.pid, name: u.pname, city: u.city, loginId: u.pmobile || u.mobile || u.id, loginMethod: 'mobile', mobile: u.pmobile || u.mobile || '', email: u.email || '',
      status: u.status || 'active', kyc: u.kyc, createdAt: u.created_at, lastLoginAt: u.last_login_at, lastLoginMethod: u.last_login_method || '',
      verified: u.kyc === 'verified', forceChange: !!u.force_change, demo: /^98100000\d{2}$/.test(u.pmobile || ''),
      assigned: u.nAssigned, completed: u.nDone }));
  }
  if (q) rows = rows.filter((u) => [u.name, u.mobile, u.email, u.loginId, u.id].some((x) => String(x || '').toLowerCase().includes(q)));
  res.json({ accounts: rows });
});

/* View one account (admin-only profile view). */
router.get('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id); if (!u) throw notFound('User not found');
  res.json({ user: { id: u.id, role: u.role, name: u.name, mobile: u.mobile, email: u.email, status: u.status || 'active', joined: u.joined, lastLoginAt: u.last_login_at, lastLoginMethod: u.last_login_method || '', forceChange: !!u.force_change } });
});

/* Admin-initiated password reset: returns a one-time temp password, forces change at
   next login, and stores only hashes. The temp password is shown exactly once. */
router.post('/users/:id/reset-password', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id); if (!u) throw notFound('User not found');
  if (u.role === 'admin' && u.id === req.auth.uid) throw bad('Use change-password for your own account');
  const temp = 'Dp' + require('crypto').randomBytes(6).toString('base64url').replace(/[-_]/g, 'A') + '7x';
  db.prepare('UPDATE users SET pass_hash=?, force_change=1, failed_logins=0, locked_until=NULL WHERE id=?').run(bcrypt.hashSync(temp, 10), u.id);
  db.prepare('INSERT INTO password_resets(user_id,token_hash,expires,used,created_by,created_at) VALUES(?,?,?,?,?,?)')
    .run(u.id, require('crypto').createHash('sha256').update(temp).digest('hex'), Date.now() + 30 * 60 * 1000, 1, req.auth.uid, Date.now());
  AUDIT.audit(req.auth.uid, 'account.reset_password', 'user', u.id, { targetRole: u.role });
  res.json({ ok: true, tempPassword: temp, mustChangePassword: true });
});

/* Force a password change at next login without changing the current one. */
router.post('/users/:id/force-change', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id); if (!u) throw notFound('User not found');
  db.prepare('UPDATE users SET force_change=1 WHERE id=?').run(u.id);
  AUDIT.audit(req.auth.uid, 'account.force_change', 'user', u.id, { targetRole: u.role });
  res.json({ ok: true });
});

/* Activate / suspend / disable. Self-demotion and last-admin lockout are refused. */
router.post('/users/:id/status', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id); if (!u) throw notFound('User not found');
  const status = v.oneOf(req.body.status, ACCOUNT_STATUSES, 'Status');
  if (u.id === req.auth.uid && status !== 'active') throw bad('You cannot disable your own account');
  if (u.role === 'admin' && status !== 'active') {
    const actives = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND status='active'").get().c;
    if (actives <= 1) throw bad('At least one active admin must remain');
  }
  db.prepare('UPDATE users SET status=? WHERE id=?').run(status, u.id);
  AUDIT.audit(req.auth.uid, 'account.status', 'user', u.id, { from: u.status || 'active', to: status },
    'Account lifecycle change from the admin accounts screen');
  res.json({ ok: true, status });
});

/* Audit trail (admin actions) for the admin UI. */
router.get('/audit', (req, res) => {
  const limit = Math.min(500, v.int(req.query.limit || 150, 'Limit', { min: 1, max: 500 }));
  res.json({ entries: AUDIT.recent(limit).map((a) => ({ id: a.id, actor: a.actor_user_id, role: a.actor_role, action: a.action, entity: a.entity, entityId: a.entity_id, detail: j(a.detail, {}), oldValue: a.old_value ? j(a.old_value, a.old_value) : null, newValue: a.new_value ? j(a.new_value, a.new_value) : null, reason: a.reason || null, ip: a.ip || null, device: a.device || null, ts: a.created_at })) });
});

/* --- Puja photo management (admin): upload, moderate, publish, download ----- */
const MEDIA = require('../services/pujaMedia');
/* Moderation queue: all media (pending first), with the puja + pandit names. */
router.get('/media', (req, res) => {
  res.json({ media: MEDIA.adminList({ status: req.query.status, source: req.query.source, limit: req.query.limit }) });
});
router.post('/pujas/:id/media', upload.media.array('media', 8), upload.verifyMagic(), wrap(async (req, res) => {
  const media = MEDIA.adminUpload({ uid: req.auth.uid, pujaId: req.params.id, files: req.files, makePrimary: !!req.body.primary, altText: req.body.altText, category: req.body.category, published: req.body.published === undefined ? true : !!req.body.published });
  /* Variants generated inline (awaited); boot-time repair remains the safety net for older rows. */
  for (const m of media) await require('../services/mediaVariants').ensureVariants(MEDIA.row(m.id));
  res.status(201).json({ media });
}));
router.get('/pujas/:id/media', (req, res) => res.json({ media: MEDIA.allForPuja(req.params.id) }));
router.patch('/media/:id', (req, res) => {
  const b = req.body || {};
  res.json({ media: MEDIA.moderate({ uid: req.auth.uid, id: req.params.id, status: b.status, published: b.published, primary: !!b.primary, rejectReason: b.rejectReason }) });
});
router.post('/media/reorder', (req, res) => res.json({ media: MEDIA.reorder(req.auth.uid, req.body.ids) }));
/* Bulk moderation: { ids: [...], op: approve|reject|publish|unpublish|delete } */
router.post('/media/bulk', (req, res) => {
  const op = v.oneOf(req.body.op, ['approve', 'reject', 'publish', 'unpublish', 'delete'], 'Operation');
  res.json(MEDIA.bulk(req.auth.uid, req.body.ids, op));
});
/* Full attribution list for the Credits view (admin-only: includes unpublished). */
router.get('/media/credits', (req, res) => res.json({ credits: MEDIA.creditsList() }));
router.delete('/media/:id', (req, res) => res.json(MEDIA.remove({ uid: req.auth.uid, role: 'admin', pid: null, id: req.params.id })));
router.get('/media/:id/download', (req, res) => {
  const f = MEDIA.fileFor(req.params.id, req.auth);
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', 'attachment; filename="' + (f.name || 'photo').replace(/[^a-zA-Z0-9._-]/g, '_') + '"');
  res.sendFile(f.file);
});

module.exports = router;
