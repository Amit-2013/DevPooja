"""Payments parity tests — port of 'payment signature verification' and
'Razorpay mode: booking is held until the signature verifies', plus the new
webhook tests (raw-body HMAC, replay idempotency, booking reconciliation)."""
import hashlib
import hmac as hmac_mod
import json

import pytest

from tests.conftest import admin_login, login, otp_login

pytestmark = pytest.mark.asyncio

RZP_KEY = "rzp_test_x"
RZP_SECRET = "shh"
HOOK_SECRET = "whsec_test_123"


def booking_body(o=None):
    d = {"pujaId": "rudra", "mode": "home", "date": otp_login.day_plus(90),
         "slot": "06:00 PM",
         "addr": {"line": "12 Test Street", "city": "Delhi NCR", "pin": "110001"},
         "panditId": "p2", "sam": [], "pra": []}
    d.update(o or {})
    return d


def sig_of(secret: str, order_id: str, payment_id: str) -> str:
    return hmac_mod.new(secret.encode(), f"{order_id}|{payment_id}".encode(),
                        hashlib.sha256).hexdigest()


async def _setup_razorpay(monkeypatch):
    monkeypatch.setenv("PAYMENT_MODE", "razorpay")
    monkeypatch.setenv("RAZORPAY_KEY_ID", RZP_KEY)
    monkeypatch.setenv("RAZORPAY_KEY_SECRET", RZP_SECRET)


class _FakeResp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def json(self):
        return self._payload


async def test_payment_signature_verification():
    from app.services.payments import verify_signature
    s = sig_of("sec", "order_1", "pay_1")
    assert verify_signature("order_1", "pay_1", s, "sec") is True
    assert verify_signature("order_1", "pay_1", s[:-1] + "0", "sec") is False
    assert verify_signature("order_1", "pay_2", s, "sec") is False
    assert verify_signature("", "pay_1", s, "sec") is False


async def test_razorpay_hold_verify_and_expiry(client, db_session, monkeypatch):
    await _setup_razorpay(monkeypatch)
    from app.models import Booking
    from app.services import bookings as B

    async def fake_create_order(amount, receipt):
        return {"orderId": "order_T1", "amount": 1, "keyId": RZP_KEY}
    monkeypatch.setattr("app.services.payments.create_order", fake_create_order)

    tc = await login(client, "customer")
    r = await client.post("/api/bookings", headers={"Authorization": "Bearer " + tc},
                          json=booking_body())
    assert r.status_code == 201
    assert r.json()["booking"]["status"] == "PendingPayment"
    assert r.json()["payment"]["orderId"] == "order_T1"
    # hidden from the customer's list and blocks the slot
    st = (await client.get("/api/state", headers={"Authorization": "Bearer " + tc})).json()
    assert not any(b["id"] == r.json()["booking"]["id"] for b in st["bookings"])
    assert (await client.post("/api/bookings", headers={"Authorization": "Bearer " + tc},
                              json=booking_body())).status_code == 409
    bid = r.json()["booking"]["id"]
    bad = await client.post("/api/payments/verify", headers={"Authorization": "Bearer " + tc},
                            json={"bookingId": bid, "razorpay_order_id": "order_T1",
                                  "razorpay_payment_id": "pay_1", "razorpay_signature": "deadbeef"})
    assert bad.status_code == 400
    ok = await client.post("/api/payments/verify", headers={"Authorization": "Bearer " + tc},
                           json={"bookingId": bid, "razorpay_order_id": "order_T1",
                                 "razorpay_payment_id": "pay_1",
                                 "razorpay_signature": sig_of(RZP_SECRET, "order_T1", "pay_1")})
    assert ok.status_code == 200
    assert ok.json()["booking"]["status"] == "Confirmed"
    # an unpaid hold older than 15 minutes is released (Node parity: expireUnpaid)
    h = await client.post("/api/bookings", headers={"Authorization": "Bearer " + tc},
                          json=booking_body({"date": otp_login.day_plus(91)}))
    row = await db_session.get(Booking, h.json()["booking"]["id"])
    row.created = row.created - 16 * 60 * 1000
    await db_session.commit()
    await client.get("/api/state", headers={"Authorization": "Bearer " + tc})
    row = await db_session.get(Booking, h.json()["booking"]["id"])
    await db_session.refresh(row)
    assert row.status == "Cancelled"
    monkeypatch.setenv("PAYMENT_MODE", "mock")


async def _hook_post(client, body: dict, secret: str, event_id="evt_1"):
    raw = json.dumps(body).encode()
    headers = {"x-razorpay-signature": hmac_mod.new(secret.encode(), raw, hashlib.sha256).hexdigest()}
    return await client.post("/api/webhooks/razorpay", content=raw, headers=headers)


async def test_webhook_bad_signature_and_unconfigured(client, monkeypatch):
    monkeypatch.setenv("RAZORPAY_WEBHOOK_SECRET", HOOK_SECRET)
    raw = json.dumps({"event": "payment.captured"}).encode()
    r = await client.post("/api/webhooks/razorpay", content=raw,
                          headers={"x-razorpay-signature": "deadbeef"})
    assert r.status_code == 400
    assert r.json()["error"] == "Bad signature"
    monkeypatch.delenv("RAZORPAY_WEBHOOK_SECRET", raising=False)
    raw2 = json.dumps({"event": "payment.captured"}).encode()
    sig = hmac_mod.new(b"any", raw2, hashlib.sha256).hexdigest()
    r2 = await client.post("/api/webhooks/razorpay", content=raw2,
                           headers={"x-razorpay-signature": sig})
    assert r2.status_code == 503


async def test_webhook_reconciles_booking_and_is_idempotent(client, db_session, monkeypatch):
    await _setup_razorpay(monkeypatch)
    monkeypatch.setenv("RAZORPAY_WEBHOOK_SECRET", HOOK_SECRET)
    from app.models import Booking

    async def fake_create_order(amount, receipt):
        return {"orderId": "order_WH1", "amount": 1, "keyId": RZP_KEY}
    monkeypatch.setattr("app.services.payments.create_order", fake_create_order)

    tc = await login(client, "customer")
    r = await client.post("/api/bookings", headers={"Authorization": "Bearer " + tc},
                          json=booking_body())
    bid = r.json()["booking"]["id"]
    row = await db_session.get(Booking, bid)
    assert row.status == "PendingPayment"

    payload = {"id": "evt_WH1", "event": "payment.captured",
               "payload": {"payment": {"entity": {
                   "id": "pay_WH1", "order_id": "order_WH1", "status": "captured"}}}}
    res = await _hook_post(client, payload, HOOK_SECRET, "evt_WH1")
    assert res.status_code == 200
    assert res.json()["ok"] is True
    row = await db_session.get(Booking, bid)
    await db_session.refresh(row)
    assert row.status == "Confirmed", "webhook reconciles the unpaid hold"
    pay_json = json.loads(row.pay)
    assert pay_json["paid"] is True and pay_json["ref"] == "pay_WH1"

    # replay of the same event id: acknowledged as duplicate, no double-apply
    res2 = await _hook_post(client, payload, HOOK_SECRET, "evt_WH1")
    assert res2.status_code == 200
    assert res2.json().get("duplicate") is True

    # a DIFFERENT event id for the same order does not corrupt the paid booking
    payload2 = dict(payload, id="evt_WH2")
    res3 = await _hook_post(client, payload2, HOOK_SECRET, "evt_WH2")
    assert res3.status_code == 200
    row = await db_session.get(Booking, bid)
    await db_session.refresh(row)
    assert row.status == "Confirmed"
    assert json.loads(row.pay)["paid"] is True
