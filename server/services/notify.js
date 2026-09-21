/* Notifications: always stored in the DB (shown in the app). If provider credentials are present in .env,
   the message is also sent via SMS / WhatsApp (Twilio REST) or email (SendGrid REST). Failures never block a request. */
const { db } = require('../db');

async function twilio(to, body, whatsapp) {
  const sid = process.env.TWILIO_SID, tok = process.env.TWILIO_TOKEN;
  const from = whatsapp ? process.env.TWILIO_WA_FROM : process.env.TWILIO_FROM;
  if (!sid || !tok || !from) return false;
  const prefix = (n) => (whatsapp ? 'whatsapp:' : '') + (n.startsWith('+') ? n : '+91' + n);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: prefix(to), From: from.startsWith('whatsapp:') || !whatsapp ? from : 'whatsapp:' + from, Body: body })
  });
  return r.ok;
}
async function sendgrid(to, subject, body) {
  const key = process.env.SENDGRID_KEY, from = process.env.MAIL_FROM;
  if (!key || !from) return false;
  const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: from }, subject, content: [{ type: 'text/plain', value: body }] })
  });
  return r.ok;
}

/* channel: 'WhatsApp' | 'SMS' | 'Email' | 'Push' */
function notify(userId, channel, message) {
  db.prepare('INSERT INTO notifs(user_id,channel,message,ts) VALUES(?,?,?,?)').run(userId, channel, message, Date.now());
  const u = db.prepare('SELECT mobile,email FROM users WHERE id=?').get(userId);
  if (!u) return;
  const job = channel === 'SMS' && u.mobile ? twilio(u.mobile, message, false)
    : channel === 'WhatsApp' && u.mobile ? twilio(u.mobile, message, true)
    : channel === 'Email' && u.email ? sendgrid(u.email, 'DevPooja update', message) : null;
  if (job) job.catch((e) => console.error('[notify]', channel, e.message));
  if (process.env.NODE_ENV !== 'test' && !process.env.QUIET) console.log(`[notify:${channel}] ${userId}: ${message}`);
}

/* Raw SMS for OTP (not stored in notifs) */
async function sendOtp(mobile, code) {
  if (process.env.NODE_ENV !== 'production') console.log(`[otp] ${mobile} -> ${code}`);
  try { await twilio(mobile, `Your DevPooja OTP is ${code}. Valid for 5 minutes.`, false); } catch (e) { console.error('[otp]', e.message); }
}
module.exports = { notify, sendOtp };
