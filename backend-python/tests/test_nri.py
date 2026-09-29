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
