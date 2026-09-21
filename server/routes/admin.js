const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const { db, setSetting, nextSeq } = require('../db');
const { requireRole } = require('../auth');
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
  if (req.body.price !== undefined) db.prepare('UPDATE pujas SET price=? WHERE id=?').run(v.int(req.body.price, 'Price', { min: 100, max: 1000000 }), p.id);
  if (req.body.hidden !== undefined) db.prepare('UPDATE pujas SET hidden=? WHERE id=?').run(req.body.hidden ? 1 : 0, p.id);
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
router.post('/orders/:id/advance', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id); if (!o) throw notFound();
  const s = ['Placed', 'Packed', 'Dispatched', 'Delivered'], nx = s[Math.min(3, s.indexOf(o.status) + 1)];
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(nx, o.id);
  notify(o.user_id, 'SMS', `Order ${o.id} is ${nx.toLowerCase()}.`);
  res.json({ ok: true });
});
router.post('/tickets/:id/resolve', (req, res) => { const r = db.prepare("UPDATE tickets SET status='Resolved' WHERE id=?").run(req.params.id); if (!r.changes) throw notFound(); res.json({ ok: true }); });
module.exports = router;
