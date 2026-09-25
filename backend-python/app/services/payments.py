"""Payment gateway adapter — port of server/services/payments.js.
PAYMENT_MODE=mock (default) marks payments as paid immediately.
PAYMENT_MODE=razorpay creates a Razorpay order and verifies the checkout signature."""
import base64
import hashlib
import hmac
import os

import httpx

from ..config import get_settings


def mode() -> str:
    return os.environ.get("PAYMENT_MODE", "mock").lower()


async def create_order(amount_rupees: int, receipt: str) -> dict:
    key = os.environ.get("RAZORPAY_KEY_ID")
    secret = os.environ.get("RAZORPAY_KEY_SECRET")
    if not key or not secret:
        raise RuntimeError("Razorpay keys are not configured")
    auth = base64.b64encode(f"{key}:{secret}".encode()).decode()
    async with httpx.AsyncClient() as client:
        r = await client.post(
            "https://api.razorpay.com/v1/orders",
            headers={"Authorization": "Basic " + auth, "Content-Type": "application/json"},
            json={"amount": round(amount_rupees * 100), "currency": "INR", "receipt": receipt},
            timeout=15)
    body = r.json() if r.content else {}
    if r.status_code >= 400:
        raise RuntimeError((body.get("error") or {}).get("description") or "Payment gateway error")
    return {"orderId": body.get("id"), "amount": body.get("amount"), "keyId": key}


def verify_signature(order_id, payment_id, signature, secret: str | None = None) -> bool:
    """HMAC-SHA256 over 'order|payment' — constant-time compare (Node parity)."""
    secret = secret or os.environ.get("RAZORPAY_KEY_SECRET")
    if not secret or not order_id or not payment_id or not signature:
        return False
    expected = hmac.new(secret.encode(), f"{order_id}|{payment_id}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, str(signature))
