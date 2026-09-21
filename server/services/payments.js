/* Payment gateway adapter. PAYMENT_MODE=mock (default) marks payments as paid immediately.
   PAYMENT_MODE=razorpay creates a Razorpay order and verifies the checkout signature. */
const crypto = require('crypto');
const mode = () => (process.env.PAYMENT_MODE || 'mock').toLowerCase();

async function createOrder(amountRupees, receipt) {
  const key = process.env.RAZORPAY_KEY_ID, secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key || !secret) throw new Error('Razorpay keys are not configured');
  const r = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(key + ':' + secret).toString('base64'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: Math.round(amountRupees * 100), currency: 'INR', receipt })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.description) || 'Payment gateway error');
  return { orderId: j.id, amount: j.amount, keyId: key };
}

function verifySignature(orderId, paymentId, signature, secret = process.env.RAZORPAY_KEY_SECRET) {
  if (!secret || !orderId || !paymentId || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(orderId + '|' + paymentId).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
module.exports = { mode, createOrder, verifySignature };
