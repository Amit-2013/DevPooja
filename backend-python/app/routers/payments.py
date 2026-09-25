"""Razorpay webhook — port of the Node handler mounted BEFORE express.json.

Parity-critical details:
- The raw request body is HMAC-verified BEFORE any JSON parsing
  (FastAPI: read the bytes from the Request directly; no Pydantic model).
- Signature: HMAC-SHA256(webhook_secret, raw_body) hex, constant-time compared
  against the X-Razorpay-Signature header. Mismatch -> 400.
- Unconfigured secret -> 503 (so a misconfigured deploy fails loudly).
- Idempotency: the same event id (wh:<id>, scope razorpay.webhook) is
  acknowledged with {ok, duplicate} and never re-applied — duplicate
  webhooks must never double-mark a payment.
- Reconciliation: payment.captured / order.paid mark the booking whose
  pay.orderId matches as PAID (status Confirmed/New by pandit assignment),
  and flip a PENDING_PAYMENT kundali to PAID (when that module is ported).
- Handler errors return 500 so Razorpay retries (same as Node)."""
import hashlib
import hmac
import json
import time

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..models import Booking, IdempotencyKey
from ..util import j

router = APIRouter(prefix="/api/webhooks", tags=["payments"])

import os


def _webhook_secret() -> str | None:
    return os.environ.get("RAZORPAY_WEBHOOK_SECRET")


@router.post("/razorpay")
async def razorpay_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    raw = await request.body()
    if len(raw) > 256 * 1024:
        return JSONResponse(status_code=413, content={"error": "Payload too large"})
    wsecret = _webhook_secret()
    if not wsecret:
        return JSONResponse(status_code=503, content={"error": "Webhook not configured"})
    sig = str(request.headers.get("x-razorpay-signature") or "")
    expected = hmac.new(wsecret.encode(), raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        return JSONResponse(status_code=400, content={"error": "Bad signature"})
    try:
        ev = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return JSONResponse(status_code=400, content={"error": "Bad payload"})

    event_id = (ev.get("id")
                or (((ev.get("payload") or {}).get("payment") or {}).get("entity") or {}).get("id")
                or "")
    if event_id:
        dup = (await db.execute(select(IdempotencyKey).where(
            IdempotencyKey.key == "wh:" + event_id,
            IdempotencyKey.scope == "razorpay.webhook"))).scalar_one_or_none()
        if dup:
            return {"ok": True, "duplicate": True}
    try:
        etype = ev.get("event") or ""
        payload = ev.get("payload") or {}
        entity = ((payload.get("payment") or payload.get("order")) or {}).get("entity") or {}
        order_id = entity.get("order_id") or ""
        if etype in ("payment.captured", "order.paid") and order_id:
            # Bookings: pay.orderId is stored inside the JSON pay column
            bk = (await db.execute(select(Booking).where(
                text("json_extract(pay, '$.orderId') = :oid").bindparams(oid=order_id)
            ).limit(1))).scalar_one_or_none()
            if bk:
                p = j(bk.pay, {})
                if not p.get("paid"):
                    bk.status = "Confirmed" if bk.pandit_id else "New"
                    bk.pay = json.dumps({**p, "paid": True,
                                         "ref": entity.get("id") or "webhook"})
                    bk.log = json.dumps(j(bk.log, []) + [["Payment received (webhook)",
                                                          time.strftime("%Y-%m-%d")]],
                                        ensure_ascii=False)
                    await db.flush()
            # Kundalis: when the kundali module lands, reconcile here
            # (order_id match, billing='PENDING_PAYMENT' -> PAID) — Node parity.
        if event_id:
            db.add(IdempotencyKey(key="wh:" + event_id, scope="razorpay.webhook",
                                  result=json.dumps({"type": etype}),
                                  created_at=int(time.time() * 1000)))
            await db.flush()
    except Exception as e:  # noqa: BLE001 — Node logs and returns 500 so Razorpay retries
        print("[webhook]", e)
        return JSONResponse(status_code=500, content={"error": "Handler error"})
    return {"ok": True}
