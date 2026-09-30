"""Phase 13 — Python twin of tests/nri.test.js: NRI packages.

Admin CRUD (deactivate-not-delete once sold), public catalogue, idempotent
checkout in package currency with the INR equivalent hitting the ledger
exactly once (NRI_PAYMENT), access control. Mirrors server/services/nri.js.
"""
import pytest
from sqlalchemy import select

from app.models import NriOrder, Transaction
from tests.conftest import admin_login, login

pytestmark = pytest.mark.asyncio


async def _mk(client, aa, **over):
    body = {"name": "Satyanarayan from abroad", "descr": "Full katha for your family back home.",
            "price": 199, "currency": "USD", "inrEquiv": 17000,
            "includes": ["Full puja by a verified pandit", "Photos and video dispatch",
                         "Prasad delivered to your family"], **over}
    r = await client.post("/api/admin/nri-packages", headers=aa, json=body)
    assert r.status_code == 201, r.text
    return r.json()["package"]


async def test_nri_admin_crud_audits_delete_protection(client):
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    p = await _mk(client, aa)
    assert p["currency"] == "USD"
    assert p["includes"] == ["Full puja by a verified pandit", "Photos and video dispatch",
                             "Prasad delivered to your family"]

    # validation
    assert (await client.post("/api/admin/nri-packages", headers=aa,
                              json={"name": "x", "price": 100, "currency": "BTC",
                                    "inrEquiv": 1})).status_code == 400, "currency whitelist"
    assert (await client.post("/api/admin/nri-packages", headers=aa,
                              json={"name": "x", "price": 0, "currency": "USD",
                                    "inrEquiv": 1})).status_code == 400, "positive price"

    patched = await client.patch("/api/admin/nri-packages/" + p["id"], headers=aa,
                                 json={"price": 249, "active": False})
    assert patched.status_code == 200, patched.text
    assert patched.json()["package"]["price"] == 249
    assert patched.json()["package"]["active"] is False

    audits = (await client.get("/api/admin/audit?limit=300", headers=aa)).json()["entries"]
    assert any(a for a in audits if a["action"] == "nri.package_create" and a["entityId"] == p["id"])
    assert any(a for a in audits if a["action"] == "nri.package_update" and a["entityId"] == p["id"])

    # never sold → deletable
    assert (await client.delete("/api/admin/nri-packages/" + p["id"], headers=aa)).status_code == 200
    audits2 = (await client.get("/api/admin/audit?limit=300", headers=aa)).json()["entries"]
    assert any(a for a in audits2 if a["action"] == "nri.package_delete" and a["entityId"] == p["id"])

    # access
    ct = {"Authorization": "Bearer " + await login(client, "customer")}
    assert (await client.post("/api/admin/nri-packages", headers=ct,
                              json={"name": "x", "price": 9, "currency": "USD"})).status_code == 403


async def test_nri_checkout_currency_ledger_idempotency(client, db_session):
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    ct = await login(client, "customer")
    pkg = await _mk(client, aa, name="Ganesh from abroad", price=149, inrEquiv=12700,
                    descr="", includes=["Puja + prasad"])

    public = (await client.get("/api/nri-packages")).json()
    assert any(x["id"] == pkg["id"] for x in public["packages"]), "public catalogue serves the package"

    r1 = await client.post("/api/nri-orders", headers={"Authorization": "Bearer " + ct},
                           json={"packageId": pkg["id"], "idem": "order-key-1"})
    assert r1.status_code == 201, r1.text
    o = r1.json()["order"]
    assert o["amount"] == 149
    assert o["currency"] == "USD"
    assert o["inrEquiv"] == 12700
    assert o["status"] == "PAID", "mock mode marks the order paid immediately"

    # retry with the same key returns the SAME order — no double sale
    r2 = await client.post("/api/nri-orders", headers={"Authorization": "Bearer " + ct},
                           json={"packageId": pkg["id"], "idem": "order-key-1"})
    assert r2.status_code == 201, r2.text
    assert r2.json()["order"]["id"] == o["id"], "idempotent replay returns the original order"
    count = (await db_session.execute(select(NriOrder.id))).scalars().all()
    assert len(count) == 1, "exactly one order row"

    # one ledger row, in INR (inr_equiv), deduped on retry
    rows = (await db_session.execute(
        select(Transaction).where(Transaction.type == "NRI_PAYMENT",
                                  Transaction.ref_id == o["id"]))).scalars().all()
    assert len(rows) == 1
    assert rows[0].amount == 12700, "ledger carries the INR equivalent"
    assert rows[0].currency == "INR"

    # delisted packages refuse checkout
    await client.patch("/api/admin/nri-packages/" + pkg["id"], headers=aa, json={"active": False})
    refused = await client.post("/api/nri-orders", headers={"Authorization": "Bearer " + ct},
                                json={"packageId": pkg["id"], "idem": "order-key-2"})
    assert refused.status_code == 404, "delisted package refused"

    # a sold package cannot be deleted
    await client.patch("/api/admin/nri-packages/" + pkg["id"], headers=aa, json={"active": True})
    d = await client.delete("/api/admin/nri-packages/" + pkg["id"], headers=aa)
    assert d.status_code == 400, d.text
    assert "Deactivate it instead" in d.json()["detail"]

    # missing idem key rejected
    assert (await client.post("/api/nri-orders", headers={"Authorization": "Bearer " + ct},
                              json={"packageId": pkg["id"]})).status_code == 400

    # customer sees only their own orders; anonymous catalogue is fine, checkout is not
    mine = (await client.get("/api/nri-orders", headers={"Authorization": "Bearer " + ct})).json()["orders"]
    assert any(x["id"] == o["id"] for x in mine)
    assert (await client.get("/api/nri-orders")).status_code == 401
    assert (await client.post("/api/nri-orders",
                              json={"packageId": pkg["id"], "idem": "anon"})).status_code == 401


async def test_nri_gateway_payments(client, db_session, monkeypatch):
    """Python twin of the Node 'NRI gateway payments' test: razorpay-mode
    checkout holds the order PENDING_PAYMENT and returns a Razorpay order in
    the PACKAGE currency; a real HMAC signature settles PAID and writes the
    INR ledger row exactly once; replay verify is a no-op; ownership holds."""
    import hashlib
    import hmac as hmac_mod

    from app.services import payments as pay

    aa = {"Authorization": "Bearer " + await admin_login(client)}
    ct = {"Authorization": "Bearer " + await login(client, "customer")}
    pkg = await _mk(client, aa, name="Abroad Gateway Pack", price=75, currency="GBP",
                    inrEquiv=8000, descr="", includes=["Puja + prasad"])

    monkeypatch.setenv("PAYMENT_MODE", "razorpay")
    monkeypatch.setenv("RAZORPAY_KEY_ID", "rzp_test_x")
    monkeypatch.setenv("RAZORPAY_KEY_SECRET", "shh")
    monkeypatch.delenv("RAZORPAY_KEY_SECRET" if False else "NOT_SET", raising=False)

    async def _fake_order(amount_rupees, receipt):
        return {"orderId": "order_GBP1", "amount": 7500, "currency": "GBP", "keyId": "rzp_test_x"}

    monkeypatch.setattr(pay, "create_order", _fake_order)

    r = await client.post("/api/nri-orders", headers=ct,
                          json={"packageId": pkg["id"], "idem": "gw-key-1"})
    assert r.status_code == 201, r.text
    o = r.json()["order"]
    assert o["status"] == "PENDING_PAYMENT", "gateway checkout holds the order"
    assert o["currency"] == "GBP"
    assert o["gatewayOrderId"] == "order_GBP1"
    assert r.json()["payment"]["currency"] == "GBP", "checkout opens in the package currency"
    assert r.json()["payment"]["amount"] == 7500, "75 GBP = 7500 pence, no conversion"
    assert r.json()["payment"]["keyId"] == "rzp_test_x"

    rows = (await db_session.execute(
        select(Transaction).where(Transaction.type == "NRI_PAYMENT",
                                  Transaction.ref_id == o["id"]))).scalars().all()
    assert rows == [], "no ledger before the money moment"

    # idempotent replay still returns the original held order
    r2 = await client.post("/api/nri-orders", headers=ct,
                           json={"packageId": pkg["id"], "idem": "gw-key-1"})
    assert r2.json()["order"]["id"] == o["id"]

    # a bad signature is refused and the order stays pending
    bad_sig = await client.post(f"/api/nri-orders/{o['id']}/verify", headers=ct,
                                json={"razorpay_order_id": "order_GBP1", "razorpay_payment_id": "pay_g1",
                                      "razorpay_signature": "deadbeef"})
    assert bad_sig.status_code == 400
    assert "verification failed" in bad_sig.json()["detail"]

    # a forged gateway order id is refused
    forged = await client.post(f"/api/nri-orders/{o['id']}/verify", headers=ct,
                               json={"razorpay_order_id": "order_OTHER", "razorpay_payment_id": "pay_g1",
                                     "razorpay_signature": "x"})
    assert forged.status_code == 400

    # real signature: HMAC-SHA256(secret, order|payment) settles the order
    sig = hmac_mod.new(b"shh", b"order_GBP1|pay_g1", hashlib.sha256).hexdigest()
    ok = await client.post(f"/api/nri-orders/{o['id']}/verify", headers=ct,
                           json={"razorpay_order_id": "order_GBP1", "razorpay_payment_id": "pay_g1",
                                 "razorpay_signature": sig})
    assert ok.status_code == 200, ok.text
    assert ok.json()["status"] == "PAID"
    db_session.expire_all()
    row = await db_session.get(NriOrder, o["id"])
    assert row.status == "PAID"
    assert row.gateway_payment_id == "pay_g1"
    assert row.gateway_order_id == "order_GBP1"

    # ledger written exactly once at the money moment, in INR (inr_equiv)
    ledger = (await db_session.execute(
        select(Transaction).where(Transaction.type == "NRI_PAYMENT",
                                  Transaction.ref_id == o["id"]))).scalars().all()
    assert len(ledger) == 1
    assert ledger[0].amount == 8000, "INR equivalent, not the GBP amount"
    assert ledger[0].currency == "INR"

    # replaying verify is an idempotent no-op (same contract as kundali)
    again = await client.post(f"/api/nri-orders/{o['id']}/verify", headers=ct,
                              json={"razorpay_order_id": "order_GBP1", "razorpay_payment_id": "pay_g1",
                                    "razorpay_signature": sig})
    assert again.status_code == 200
    ledger2 = (await db_session.execute(
        select(Transaction).where(Transaction.type == "NRI_PAYMENT",
                                  Transaction.ref_id == o["id"]))).scalars().all()
    assert len(ledger2) == 1

    # another customer cannot verify someone else's order (OTP login = distinct user)
    from tests.conftest import otp_login
    other = await otp_login(client, "9000088877", "NRI Gateway Other")
    o2 = (await client.post("/api/nri-orders", headers={"Authorization": "Bearer " + other},
                            json={"packageId": pkg["id"], "idem": "gw-key-2"})).json()["order"]
    foreign = await client.post(f"/api/nri-orders/{o2['id']}/verify",
                                headers={"Authorization": "Bearer " + await login(client, "customer")},
                                json={"razorpay_order_id": "x", "razorpay_payment_id": "y",
                                      "razorpay_signature": "z"})
    assert foreign.status_code == 404, "ownership enforced on verify"
