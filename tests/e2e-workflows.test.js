/* End-to-end workflow suite — the MASTER-AUDIT §33–37 item "E2E workflows to
   script-test: onboarding, booking (with availability), customized puja, KYC,
   agreement, payout".

   Unlike the per-domain suites (kyc.test.js, agreements.test.js, ledger.test.js …)
   which each probe one module in isolation, every test here walks a whole user
   journey across module boundaries over real HTTP against the real app:
   who the actors are, what they do in order, and the invariants that must hold
   at each hop (slot contention, role gates, version locks, audit trail).

   Run: node --test tests/e2e-workflows.test.js   (wired into `npm test` -> CI) */
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.QUIET = '1';
process.env.JWT_SECRET = 'e2e-workflows-test';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-e2e-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const test = require('node:test');
const assert = require('node:assert/strict');
const seedMod = require('../server/seed');
const app = require('../server/index.js');

let server, base;
test.before(async () => {
  await seedMod.settledMedia();
  await new Promise((r) => { server = app.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; r(); }); });
});
test.after(() => { server.closeAllConnections(); server.close(); });

async function call(method, url, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (form) payload = form; else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + '/api' + url, { method, headers, body: payload });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}
const login = async (role) => (await call('POST', '/auth/demo', { body: { role } })).json.token;
const admin = async () => (await call('POST', '/auth/admin', { body: { email: 'admin@daivikpuja.in', password: 'admin123' } })).json.token;
/* Noon-anchored so a run near midnight never lands on the wrong calendar day;
   60+ days out keeps the flow clear of the demo mock-booking window (day 2..47),
   which would otherwise collide with these slots and flip an assertion. */
const dayPlus = (n) => { const d = new Date(); d.setHours(12); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const bookingBody = (o = {}) => ({ pujaId: 'satyanarayan', mode: 'home', date: dayPlus(60), slot: '10:00 AM', addr: { line: '12 Test Street', city: 'Delhi NCR', pin: '110001' }, panditId: 'p1', sam: [], pra: [], ...o });
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x11, 0x22, 0x33, 0x44]);
const pay = (token, id) => call('POST', '/payments/verify', { token, body: { bookingId: id, razorpay_order_id: 'o_' + id, razorpay_payment_id: 'p_' + id, razorpay_signature: 'sig_' + id } });
const audits = async (a, action) => (await call('GET', '/admin/audit?limit=500', { token: a })).json.entries.filter((e) => !action || e.action === action);

/* ---------------------------------------------------------------- 1. onboarding */
test('onboarding: guest OTP becomes a customer; a stranger registers as a pandit pending KYC', async () => {
  const a = await admin();

  /* --- customer: phone in, account out, immediately usable --- */
  const mobile = '9811100901';
  assert.equal((await call('POST', '/auth/otp/send', { body: { mobile } })).status, 200, 'OTP sent');
  const reg = await call('POST', '/auth/otp/verify', { body: { mobile, otp: '123456', name: 'E2E Devotee' } });
  assert.equal(reg.status, 200, 'first verify creates the account');
  assert.ok(reg.json.token, 'session issued on signup');

  const st = (await call('GET', '/state', { token: reg.json.token })).json;
  assert.equal(st.me.n, 'E2E Devotee', 'the new customer is in their own state (serialize: n)');
  assert.equal(st.me.m, mobile, 'the signup mobile is on the account');
  assert.equal(st.dash, undefined, 'customer-scoped payload: the admin KPI block is never leaked');

  /* the account is visible to operations, not just to itself */
  const accounts = (await call('GET', '/admin/accounts/customer', { token: a })).json.accounts;
  assert.ok(accounts.some((c) => c.mobile === mobile),
    'admin account list contains the new signup');

  /* wrong OTP never yields a session */
  await call('POST', '/auth/otp/send', { body: { mobile } });
  assert.equal((await call('POST', '/auth/otp/verify', { body: { mobile, otp: '000000' } })).json.token, undefined,
    'a wrong OTP issues no token');

  /* --- pandit: registration is gated on OTP + an ID document --- */
  const pm = '9000044451';
  const form = (withDoc) => {
    const f = new FormData();
    Object.entries({ name: 'Pt. E2E Onboard', mobile: pm, otp: '123456', city: 'Pune', exp: '5', langs: 'Hindi', spec: 'ganesh,lakshmi' })
      .forEach(([k, v]) => f.append(k, v));
    if (withDoc) f.append('idDoc', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'id.pdf');
    return f;
  };
  await call('POST', '/auth/otp/send', { body: { mobile: pm } });
  assert.equal((await call('POST', '/pandit/register', { form: form(false) })).status, 400,
    'no ID document -> refused');
  await call('POST', '/auth/otp/send', { body: { mobile: pm } });
  assert.equal((await call('POST', '/pandit/register', { form: form(true) })).status, 201,
    'OTP + ID document -> registered');

  const pst = (await call('GET', '/state', { token: a })).json;
  const np = pst.pandits.find((p) => p.n === 'Pt. E2E Onboard');
  assert.ok(np, 'the new pandit exists');
  assert.equal(np.st, 'pending', 'a fresh registration is NOT bookable until reviewed');
  assert.deepEqual(np.kyc, ['idDoc'], 'the uploaded document is attached to the profile');

  /* operations can promote it — and only then does it become bookable */
  const pid = np.id;
  assert.ok(pid, 'serialized pandit carries its id');
  const act = await call('POST', `/admin/pandits/${pid}/lifecycle`, { token: a, body: { lifecycle: 'ACTIVE', reason: 'Documents reviewed' } });
  assert.equal(act.json.lifecycle, 'ACTIVE', 'reviewed registration activated');

  /* promotion is on the audit trail with old -> new */
  const log = await audits(a, 'pandit.lifecycle');
  assert.ok(log.some((e) => e.entityId === pid && e.detail && e.detail.to === 'ACTIVE'),
    'activation audited');
});

/* ------------------------------------------------- 2. booking with availability */
test('booking: availability list drives the choice, contention 409s, cancel frees the slot', async () => {
  const a = await admin();
  const date = dayPlus(70), slot = '10:00 AM';

  /* the customer only books pandits the availability endpoint offers */
  const avail = (await call('GET', `/pandits/available?date=${date}&slot=${encodeURIComponent(slot)}&mode=home&city=Delhi%20NCR`, { token: await login('customer') })).json.pandits;
  assert.ok(Array.isArray(avail), 'availability list returns pandits');
  assert.ok(avail.some((p) => p.id === 'p1'), 'p1 is available for that date+slot');

  /* book it */
  const c1 = await login('customer');
  const first = await call('POST', '/bookings', { token: c1, body: bookingBody({ date, slot }) });
  assert.equal(first.status, 201, 'first booking accepted: ' + JSON.stringify(first.json));
  const b = first.json.booking || first.json;
  assert.ok(b.id, 'booking id returned');

  /* a second, genuinely DIFFERENT customer wants the same pandit+slot -> contention.
     login('customer') always resolves to the same demo identity, so the rival is
     onboarded through OTP to get an account that is not the owner. */
  const rm = '9000077771';
  await call('POST', '/auth/otp/send', { body: { mobile: rm } });
  const c2 = (await call('POST', '/auth/otp/verify', { body: { mobile: rm, otp: '123456', name: 'E2E Rival' } })).json.token;
  assert.ok(c2, 'rival customer onboarded');
  const clash = await call('POST', '/bookings', { token: c2, body: bookingBody({ date, slot }) });
  assert.equal(clash.status, 409, 'the same slot cannot be double-booked');
  assert.equal(clash.json.error, 'That pandit is not available: Already booked in the ' + slot + ' slot on this date',
    'the conflict names the exact slot (availability.js CONFLICT, surfaced by the booking route)');

  /* ...and the availability list agrees the slot is now taken */
  const after = (await call('GET', `/pandits/available?date=${date}&slot=${encodeURIComponent(slot)}&mode=home&city=Delhi%20NCR`, { token: c2 })).json.pandits;
  assert.ok(!after.some((p) => p.id === 'p1'), 'availability now excludes the booked pandit');

  /* a stranger cannot even see it: non-owners get 404, not a leaked id */
  assert.equal((await call('POST', `/bookings/${b.id}/cancel`, { token: c2 })).status, 404,
    'a booking someone else owns is not addressable');

  /* owner cancels -> refund path runs and the slot returns to the pool */
  const cancel = await call('POST', `/bookings/${b.id}/cancel`, { token: c1 });
  assert.equal(cancel.status, 200, 'owner cancel succeeds');
  const freed = (await call('GET', `/pandits/available?date=${date}&slot=${encodeURIComponent(slot)}&mode=home&city=Delhi%20NCR`, { token: c2 })).json.pandits;
  assert.ok(freed.some((p) => p.id === 'p1'), 'slot released back to availability');
  assert.equal((await call('POST', '/bookings', { token: c2, body: bookingBody({ date, slot }) })).status, 201,
    'another customer can book the freed slot');

  /* the whole episode is on the audit trail */
  const log = await audits(a);
  assert.ok(log.some((e) => /booking/i.test(e.action || '')), 'booking lifecycle audited');
});

/* ------------------------------------------------------- 3. customized puja */
test('customized puja: public request -> admin queue -> reviewed -> converted into a catalog puja', async () => {
  const a = await admin();

  /* the public form validates before it ever reaches the queue */
  assert.equal((await call('POST', '/custom-puja', { body: { name: 'X', mobile: '123' } })).status, 400,
    'incomplete request refused');

  const submit = await call('POST', '/custom-puja', {
    body: {
      name: 'E2E Custom Devotee', mobile: '9876500011', purpose: 'Special griha shanti',
      deity: 'Shiva', city: 'Pune', budget: 6000, notes: 'Family tradition, north-Indian vidhi',
    },
  });
  assert.equal(submit.status, 201, 'valid request accepted');

  /* a customer must not see the operations queue */
  assert.equal((await call('GET', '/admin/custom-requests', { token: await login('customer') })).status, 403,
    'queue is admin-only');

  const list = (await call('GET', '/admin/custom-requests', { token: a })).json.requests;
  const req = list.find((r) => r.name === 'E2E Custom Devotee');
  assert.ok(req, 'request landed in the admin queue');
  assert.equal(req.status, 'NEW');

  /* review it, with history */
  assert.equal((await call('PATCH', '/admin/custom-requests/' + req.id, { token: a, body: { status: 'UNDER_REVIEW', adminNotes: 'Called, confirmed details' } })).status, 200);
  const reviewed = (await call('GET', '/admin/custom-requests', { token: a })).json.requests.find((r) => r.id === req.id);
  assert.ok(reviewed.history.some((h) => String(h[0]).includes('UNDER_REVIEW')), 'status history tracked');

  /* convert: the request becomes a real (hidden) catalog entry */
  const conv = await call('POST', '/admin/custom-requests/' + req.id + '/convert', { token: a, body: { name: 'E2E Special Griha Shanti', hindi: 'E2E विशेष', price: 5500 } });
  assert.equal(conv.status, 201, 'conversion creates a puja');
  assert.ok(conv.json.pujaId);

  const cst = (await call('GET', '/state', { token: a })).json;
  const made = cst.catalog.pujas.find((p) => p.id === conv.json.pujaId);
  assert.ok(made, 'the converted puja is in the catalog');
  assert.equal(made.price, 5500, 'price carried over');
  assert.ok(made.hidden, 'stays hidden until an operator unmasks it');

  const done = (await call('GET', '/admin/custom-requests', { token: a })).json.requests.find((r) => r.id === req.id);
  assert.equal(done.status, 'SCHEDULED', 'conversion schedules the request against the new puja');
  assert.equal(done.pujaId || done.puja_id, conv.json.pujaId, 'the request points at the puja it became');
});

/* ------------------------------------------------------------------- 4. KYC */
test('KYC: pandit uploads, admin reviews to VERIFIED, pandit sees it, every hop audited', async () => {
  const a = await admin(), tp = await login('pandit');

  const upload = async (docType, name) => {
    const fd = new FormData();
    fd.append('doc', new Blob([jpeg], { type: 'image/jpeg' }), name);
    fd.append('docType', docType);
    const r = await fetch(base + '/api/pandit/kyc/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + tp }, body: fd });
    return { status: r.status, doc: (await r.json()).document };
  };

  const aad = await upload('AADHAAR', 'aadhaar.jpg');
  assert.equal(aad.status, 201, 'upload accepted');
  assert.equal(aad.doc.status, 'PENDING');

  /* review begins, then verifies with an expiry */
  const review = await call('POST', `/admin/kyc/${aad.doc.id}/decide`, { token: a, body: { status: 'UNDER_REVIEW' } });
  assert.equal(review.json.document.status, 'UNDER_REVIEW');
  const verified = await call('POST', `/admin/kyc/${aad.doc.id}/decide`, { token: a, body: { status: 'VERIFIED', expiresAt: Date.now() + 30 * 86400000 } });
  assert.equal(verified.json.document.status, 'VERIFIED');
  assert.ok(verified.json.document.expiresAt, 'expiry recorded');

  /* rejection requires a documented reason */
  const pan = await upload('PAN', 'pan.jpg');
  assert.equal((await call('POST', `/admin/kyc/${pan.doc.id}/decide`, { token: a, body: { status: 'REJECTED' } })).status, 400,
    'rejection without a reason refused');
  const rej = await call('POST', `/admin/kyc/${pan.doc.id}/decide`, { token: a, body: { status: 'REJECTED', reason: 'Blurry photo' } });
  assert.equal(rej.json.document.rejectReason, 'Blurry photo');

  /* the pandit sees both outcomes, reasons included */
  const mine = (await call('GET', '/pandit/kyc/documents', { token: tp })).json.documents;
  assert.ok(mine.some((d) => d.id === aad.doc.id && d.status === 'VERIFIED'), 'pandit sees the verified doc');
  assert.ok(mine.some((d) => d.status === 'REJECTED' && d.rejectReason === 'Blurry photo'), 'pandit sees the rejection reason');

  /* admin summary counts reflect the decisions */
  const sum = (await call('GET', '/admin/kyc', { token: a })).json;
  assert.ok(sum.docs.some((d) => d.id === aad.doc.id && d.status === 'VERIFIED'));
  assert.ok(sum.counts.VERIFIED >= 1);

  /* both decisions are on the audit trail with old -> new (this flow walks the
     explicit review hop, so the chain is PENDING -> UNDER_REVIEW -> VERIFIED) */
  const log = await audits(a, 'kyc.decide');
  assert.ok(log.some((e) => e.detail && e.detail.from === 'PENDING' && e.detail.to === 'UNDER_REVIEW'),
    'PENDING -> UNDER_REVIEW audited');
  assert.ok(log.some((e) => e.detail && e.detail.from === 'UNDER_REVIEW' && e.detail.to === 'VERIFIED'),
    'UNDER_REVIEW -> VERIFIED audited');
  assert.ok(log.some((e) => e.detail && e.detail.reason), 'the rejection reason is recorded');

  /* a customer can never reach the review desk */
  assert.equal((await call('GET', '/admin/kyc', { token: await login('customer') })).status, 403);
});

/* --------------------------------------------------------------- 5. agreement */
test('agreement: draft -> published with hash -> pandit accepts with consent+OTP -> registry + version lock', async () => {
  const a = await admin(), tp = await login('pandit');
  const crypto = require('crypto');
  const body = 'Pandit partner agreement (E2E). The pandit commits to the code of conduct.';

  /* nothing exists for pandits until publication */
  const draft = await call('POST', '/admin/agreements', { token: a, body: { title: 'E2E partner agreement', body } });
  assert.equal(draft.status, 201);
  assert.equal(draft.json.agreement.status, 'DRAFT');
  assert.equal((await call('GET', '/pandit/agreement', { token: tp })).json.current, null, 'drafts are invisible to pandits');
  assert.equal((await call('POST', '/pandit/agreement/accept', { token: tp, body: { agreementId: draft.json.agreement.id, consent: true, otp: '123456' } })).status, 404,
    'cannot accept an unpublished agreement');

  /* publish: hash is sha256(body) */
  const pub = await call('POST', `/admin/agreements/${draft.json.agreement.id}/publish`, { token: a, body: {} });
  assert.equal(pub.json.agreement.status, 'PUBLISHED');
  assert.equal(pub.json.agreement.documentHash, crypto.createHash('sha256').update(body).digest('hex'), 'document hash pinned');
  assert.equal((await call('POST', `/admin/agreements/${draft.json.agreement.id}/publish`, { token: a, body: {} })).status, 409, 'double publish refused');

  /* the pandit must consent AND pass OTP */
  const cur = (await call('GET', '/pandit/agreement', { token: tp })).json.current;
  assert.equal(cur.version, 1);
  assert.equal((await call('POST', '/pandit/agreement/accept', { token: tp, body: { agreementId: cur.id, consent: false, otp: '123456' } })).status, 400, 'consent required');
  assert.equal((await call('POST', '/pandit/agreement/accept', { token: tp, body: { agreementId: cur.id, consent: true } })).status, 400, 'OTP required');
  assert.equal((await call('POST', '/pandit/agreement/accept', { token: tp, body: { agreementId: cur.id, consent: true, otp: '000000' } })).status, 400, 'wrong OTP refused');

  await call('POST', '/auth/otp/send', { body: { mobile: '9810000001' } }); // p1's registered mobile
  const acc = await call('POST', '/pandit/agreement/accept', { token: tp, body: { agreementId: cur.id, consent: true, otp: '123456' } });
  assert.equal(acc.status, 200, 'acceptance recorded');
  assert.equal(acc.json.acceptance.method, 'DIGITAL');
  assert.equal(acc.json.acceptance.otpVerified, true);
  assert.ok(acc.json.acceptance.ip && acc.json.acceptance.device, 'IP + device captured');

  /* version lock: the same version cannot be accepted twice */
  await call('POST', '/auth/otp/send', { body: { mobile: '9810000001' } });
  assert.equal((await call('POST', '/pandit/agreement/accept', { token: tp, body: { agreementId: cur.id, consent: true, otp: '123456' } })).status, 409,
    'duplicate acceptance refused');

  /* admin registry + enriched audit carry the acceptance */
  const reg = (await call('GET', `/admin/agreements/${cur.id}/acceptances`, { token: a })).json.acceptances;
  assert.equal(reg.length, 1, 'exactly one acceptance on the registry');
  assert.equal(reg[0].method, 'DIGITAL');
  const log = await audits(a, 'agreement.accepted');
  assert.equal(log.length, 1, 'acceptance audited once');
  assert.equal(log[0].ip, acc.json.acceptance.ip, 'audit stores the same IP the API returned');
  assert.ok(log[0].newValue && log[0].newValue.version === 1);

  /* an accepted version is locked against archiving */
  assert.equal((await call('POST', `/admin/agreements/${cur.id}/archive`, { token: a, body: {} })).status, 409,
    'accepted agreements cannot be archived');

  /* role gates: a pandit never reaches the admin agreement desk */
  assert.equal((await call('GET', '/admin/agreements', { token: tp })).status, 403);
});

/* ---------------------------------------------------------------- 6. payout */
test('payout: booking -> payment -> completed -> PENDING -> process -> disbursed with UTR', async () => {
  const a = await admin(), ct = await login('customer');
  const date = dayPlus(80);

  /* 1. book and pay for it (mock gateway) */
  const created = await call('POST', '/bookings', { token: ct, body: bookingBody({ date, slot: '06:00 PM' }) });
  assert.equal(created.status, 201, 'booking created');
  const b = created.json.booking || created.json;
  assert.equal((await pay(ct, b.id)).status, 200, 'payment verified');

  /* 2. the puja is performed -> operations mark it completed */
  assert.equal((await call('POST', `/admin/bookings/${b.id}/status`, { token: a, body: { status: 'Completed' } })).status, 200,
    'booking completed');

  /* 3. completion mints a PENDING payout for the pandit, with a money trail */
  let ast = (await call('GET', '/state', { token: a })).json;
  const po = ast.payouts.find((p) => p.b === b.id);
  assert.ok(po, 'a payout row exists for the completed booking');
  assert.equal(po.st, 'PENDING', 'it starts pending');
  assert.ok(po.amt > 0, 'payout amount is non-zero');
  assert.ok(po.gross >= po.amt, 'gross covers the net (money trail present)');
  assert.equal(po.comm, po.gross - po.amt + (po.tax || 0) - (po.adj || 0) + (po.refd || 0),
    'commission reconciles gross -> net');

  /* 4. finance moves it: pending -> processing -> disbursed */
  assert.equal((await call('POST', `/admin/payouts/${po.id}/process`, { token: a, body: {} })).status, 200, 'processing starts');
  const utr = 'UTRE2E' + po.id.slice(-6);
  const disb = await call('POST', `/admin/payouts/${po.id}/disburse`, { token: a, body: { utr } });
  assert.equal(disb.status, 200, 'disbursed');
  assert.equal(disb.json.payout.amt, po.amt, 'amount unchanged by the transition');

  /* 5. the state agrees, with the UTR we handed over */
  ast = (await call('GET', '/state', { token: a })).json;
  const after = ast.payouts.find((p) => p.id === po.id);
  assert.equal(after.st, 'DISBURSED');
  assert.equal(after.utr, utr, 'UTR persisted');
  assert.ok(after.dd, 'disbursement date stamped');

  /* 6. and the pandit's own view shows the same money */
  const pst = (await call('GET', '/state', { token: await login('pandit') })).json;
  assert.ok(pst.payouts.some((p) => p.id === po.id && p.st === 'DISBURSED'),
    'the pandit sees their disbursed payout');

  /* 7. the money movement is audited */
  const log = await audits(a);
  assert.ok(log.some((e) => /payout/i.test(e.action || '')), 'payout transition audited');

  /* 8. an already-disbursed payout cannot be transitioned again */
  assert.ok((await call('POST', `/admin/payouts/${po.id}/disburse`, { token: a, body: { utr: 'UTR2' } })).status >= 400,
    'DISBURSED is terminal');
});
