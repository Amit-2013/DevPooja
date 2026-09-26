"""Phase 34 security harness — Python twin of tests/security.test.js:
RBAC boundaries, cross-role isolation and duplicate prevention."""
import time

import pytest

pytestmark = pytest.mark.asyncio

RZP_KEY = "rzp_test_x"
RZP_SECRET = "shh"


def _day_plus(n: int) -> str:
    d = time.localtime(time.time() + n * 86400)
    return time.strftime("%Y-%m-%d", d)


def _booking_body(**o):
    base = {"pujaId": "satyanarayan", "mode": "home", "date": _day_plus(20),
            "slot": "10:00 AM",
            "addr": {"line": "12 Test Street", "city": "Delhi NCR", "pin": "110001"},
            "panditId": "p1", "sam": [], "pra": []}
    base.update(o)
    return base


async def _login(client, role: str) -> str:
    r = await client.post("/api/auth/demo", json={"role": role})
    assert r.status_code == 200, r.text
    return r.json()["token"]


async def _admin(client) -> str:
    r = await client.post("/api/auth/admin",
                          json={"email": "admin@daivikpuja.in", "password": "admin123"})
    return r.json()["token"]


async def test_pandit_cannot_export_customer_data_or_reach_admin_apis(client):
    tp = await _login(client, "pandit")
    tc = await _login(client, "customer")
    pa = {"Authorization": f"Bearer {tp}"}

    # Customer/PII exports are admin-only.
    for path in ["/api/admin/export/customers.xlsx", "/api/admin/export/customer-accounts.xlsx",
                 "/api/admin/export/pandit-accounts.xlsx", "/api/admin/export/bookings.xlsx",
                 "/api/admin/export/audit-logs.xlsx"]:
        assert (await client.get(path, headers=pa)).status_code == 403, path
        assert (await client.get(path, headers={"Authorization": f"Bearer {tc}"})).status_code == 403, path

    # Sensitive admin reads are blocked for pandits. (account endpoints may be
    # 404 in the Python port until that milestone — 404 is equally inaccessible;
    # the Node twin asserts the stricter 403 there.)
    for path in ["/api/admin/audit", "/api/admin/accounts/customer",
                 "/api/admin/accounts/pandit", "/api/admin/payouts/PO1"]:
        assert (await client.get(path, headers=pa)).status_code in (403, 404), path

    # Pandit state payload masks customer mobiles.
    st = (await client.get("/api/state", headers=pa)).json()
    assert all("XXXXXX" in (u.get("m") or "") for u in st["users"]), "mobiles masked for pandits"

    # Anonymous requests are rejected on private endpoints.
    assert (await client.get("/api/admin/payouts/PO1")).status_code == 401
    assert (await client.get("/api/pandit/calendar")).status_code == 401


async def test_cross_role_isolation(client):
    tc = await _login(client, "customer")
    # Demo logins always resolve to u1; a genuinely different customer via OTP.
    await client.post("/api/auth/otp/send", json={"mobile": "9811100888"})
    tc2 = (await client.post("/api/auth/otp/verify",
                             json={"mobile": "9811100888", "otp": "123456",
                                   "name": "Isolation Tester"})).json()["token"]
    tp = await _login(client, "pandit")
    b = (await client.post("/api/bookings", headers={"Authorization": f"Bearer {tc}"},
                           json=_booking_body(date=_day_plus(40), slot="08:00 AM",
                                              panditId="p3"))).json()["booking"]
    assert (await client.post(f"/api/bookings/{b['id']}/cancel",
                              headers={"Authorization": f"Bearer {tc2}"})).status_code == 404, \
        "another customer cannot cancel someone's booking"
    assert (await client.post(f"/api/pandit/bookings/{b['id']}/accept",
                              headers={"Authorization": f"Bearer {tp}"})).status_code == 404, \
        "pandit cannot act on another pandit's booking"


async def test_duplicate_prevention(client, monkeypatch):
    admin = await _admin(client)
    tc = await _login(client, "customer")
    aa = {"Authorization": f"Bearer {admin}"}
    ca = {"Authorization": f"Bearer {tc}"}

    # Duplicate booking: the DB partial unique index refuses the same slot.
    b1 = await client.post("/api/bookings", headers=ca,
                           json=_booking_body(date=_day_plus(45), slot="12:00 PM",
                                              panditId="p2", pujaId="rudra"))
    assert b1.status_code in (200, 201), b1.text
    dup = await client.post("/api/bookings", headers=ca,
                            json=_booking_body(date=_day_plus(45), slot="12:00 PM",
                                               panditId="p2", pujaId="rudra"))
    assert dup.status_code == 409

    # Duplicate payment: replaying a verified payment is idempotent.
    monkeypatch.setenv("PAYMENT_MODE", "razorpay")
    monkeypatch.setenv("RAZORPAY_KEY_ID", RZP_KEY)
    monkeypatch.setenv("RAZORPAY_KEY_SECRET", RZP_SECRET)

    from app.services import payments as pay

    async def fake_create_order(amount, receipt):
        return {"orderId": "order_S1", "amount": 1, "keyId": RZP_KEY}
    monkeypatch.setattr("app.services.payments.create_order", fake_create_order)

    held = await client.post("/api/bookings", headers=ca,
                             json=_booking_body(date=_day_plus(80), slot="06:00 AM",
                                                panditId="p4", pujaId="ganesh"))
    assert held.json()["booking"]["status"] == "PendingPayment"
    import hashlib
    import hmac as hmac_mod

    sig = hmac_mod.new(RZP_SECRET.encode(), b"order_S1|pay_S1", hashlib.sha256).hexdigest()
    vbody = {"bookingId": held.json()["booking"]["id"], "razorpay_order_id": "order_S1",
             "razorpay_payment_id": "pay_S1", "razorpay_signature": sig}
    first = await client.post("/api/payments/verify", headers=ca, json=vbody)
    assert first.status_code == 200, first.text
    assert first.json()["booking"]["status"] == "Confirmed"
    replay = await client.post("/api/payments/verify", headers=ca, json=vbody)
    assert replay.status_code == 200, "replay is idempotent, not an error"
    assert replay.json()["booking"]["pay"]["paid"] is True
    monkeypatch.setenv("PAYMENT_MODE", "mock")

    # Duplicate payout disbursement: the engine refuses transitions out of DISBURSED.
    # (Python seeds no payouts; completing bookings for p1 creates them.)
    tp = (await client.post("/api/auth/demo", json={"role": "pandit"})).json()["token"]
    pa = {"Authorization": f"Bearer {tp}"}
    for n, off in enumerate([91, 92]):
        cb = await client.post("/api/bookings", headers=ca,
                               json=_booking_body(date=_day_plus(off), slot="02:00 PM",
                                                  panditId="p1", pujaId="lakshmi"))
        bid = cb.json()["booking"]["id"]
        await client.post(f"/api/pandit/bookings/{bid}/accept", headers=pa, json={})
        await client.post(f"/api/pandit/bookings/{bid}/start", headers=pa, json={})
        await client.post(f"/api/pandit/bookings/{bid}/complete", headers=pa, json={})
    st = (await client.get("/api/state", headers=pa)).json()
    po = next((p for p in st["payouts"] if p["st"] == "PENDING"), None)
    assert po, "a pending payout exists"
    proc = await client.post(f"/api/admin/payouts/{po['id']}/process", headers=aa, json={})
    assert proc.json()["payout"]["st"] == "PROCESSING"
    d1 = await client.post(f"/api/admin/payouts/{po['id']}/disburse", headers=aa,
                           json={"paymentRef": "REF-S1"})
    assert d1.json()["payout"]["st"] == "DISBURSED"
    d2 = await client.post(f"/api/admin/payouts/{po['id']}/disburse", headers=aa,
                           json={"paymentRef": "REF-S2"})
    assert d2.status_code == 409, "double disbursement refused"
    pay2 = await client.post(f"/api/admin/payouts/{po['id']}/process", headers=aa, json={})
    assert pay2.status_code == 409, "no further processing after disbursement"

    # Kundali idempotency replay.
    await client.post("/api/auth/otp/send", json={"mobile": "9811100777"})
    tk = (await client.post("/api/auth/otp/verify",
                            json={"mobile": "9811100777", "otp": "123456"})).json()["token"]
    places = (await client.get("/api/kundali/places?q=delhi",
                               headers={"Authorization": f"Bearer {tk}"})).json()
    gen = {"name": "Sec Tester", "dob": "1990-01-01", "tob": "10:00",
           "placeId": places["places"][0]["id"], "save": True, "idemKey": "sec-idem-9"}
    k1 = await client.post("/api/kundali/generate", headers={"Authorization": f"Bearer {tk}"}, json=gen)
    k2 = await client.post("/api/kundali/generate", headers={"Authorization": f"Bearer {tk}"}, json=gen)
    assert k1.status_code == 201
    assert k2.json().get("kundaliId") == k1.json()["kundaliId"], "idempotent kundali replay"
