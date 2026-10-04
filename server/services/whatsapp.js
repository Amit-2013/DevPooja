'use strict';
/* WhatsApp provider adapter for the comms engine — "a stub behind env config".
   WHATSAPP_PROVIDER picks the transport:

     stub   (default)  accepts every message, NEVER contacts a network — so the
                       demo, tests and a fresh clone are safe by construction;
     twilio            real send through the Twilio WhatsApp API
                       (TWILIO_SID / TWILIO_TOKEN / TWILIO_WA_FROM);
     none / off        disabled: the in-app row still lands, nothing is sent.

   The string returned by send() is written to the delivery record's detail
   column, so the campaign detail table shows exactly what the adapter did
   ("stub accepted …", "disabled …", "sending…"). A real twilio send finishes
   later and updates the SAME delivery row with the final result.

   Python twin: backend-python/app/services/whatsapp.py */
const { db } = require('../db');

let stubSeq = 0;

const provider = () => String(process.env.WHATSAPP_PROVIDER === undefined ? 'stub' : process.env.WHATSAPP_PROVIDER).trim().toLowerCase();

/* Synchronous answer for the delivery record. twilio returns a provisional
   "sending…" and updates the row again when the request settles. */
function send({ to, message, deliveryId }) {
  const p = provider();
  if (p === 'stub') return 'whatsapp stub accepted message stub-' + (++stubSeq) + ' (WHATSAPP_PROVIDER=stub, nothing sent)';
  if (p === 'none' || p === 'off') return 'whatsapp adapter disabled (WHATSAPP_PROVIDER=' + p + ')';
  if (p === 'twilio') {
    const sid = process.env.TWILIO_SID, tok = process.env.TWILIO_TOKEN, from = process.env.TWILIO_WA_FROM;
    if (!sid || !tok || !from) return 'twilio adapter not configured (TWILIO_SID / TWILIO_TOKEN / TWILIO_WA_FROM missing)';
    fire(sid, tok, from, to, message)
      .then((r) => finish(deliveryId, r))
      .catch((e) => finish(deliveryId, 'twilio adapter error: ' + e.message));
    return 'twilio adapter: sending…';
  }
  return 'unknown WHATSAPP_PROVIDER "' + p + '" — message not sent';
}

function finish(deliveryId, result) {
  if (!deliveryId) return;
  try { db.prepare('UPDATE notification_deliveries SET detail=? WHERE id=?').run(result, deliveryId); } catch (e) { /* record already gone */ }
}

async function fire(sid, tok, from, to, body) {
  const num = String(to || '');
  const dest = 'whatsapp:' + (num.startsWith('+') ? num : '+91' + num);
  const src = String(from).startsWith('whatsapp:') ? from : 'whatsapp:' + from;
  const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: dest, From: src, Body: body })
  });
  return r.ok ? 'twilio adapter sent (whatsapp:' + num + ')' : 'twilio adapter failed (HTTP ' + r.status + ')';
}

module.exports = { send, provider };
