"""Phase 12 — Python twin of tests/temple.test.js: temple management.

Admin CRUD over the catalog temples (the Python admin surface had ZERO temple
routes before this), active flag gating the customer directory AND temple-mode
bookings (price_request + create), delete-vs-deactivate, audits, access.
"""
import time

import pytest
from sqlalchemy import select

from app.models import Booking, Temple
from tests.conftest import admin_login, day_plus, login

pytestmark = pytest.mark.asyncio


def _booking_body(o=None):
    o = o or {}
    return {"pujaId": "rudra", "mode": "temple", "date": day_plus(21), "slot": "08:00 AM",
            "templeId": "t1", "panditId": "p2", "sam": [], "pra": [],
            "addr": {"line": "12 Test Street", "city": "Delhi NCR", "pin": "110001"}, **o}


async def _booking(client, tok, o=None):
    r = await client.post("/api/bookings", headers={"Authorization": "Bearer " + tok},
                          json=_booking_body(o))
    return r


async def test_temple_crud_audit_access(client, db_session):
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    before = (await client.get("/api/admin/temples", headers=aa)).json()["temples"]
    assert len(before) >= 6, "seeded temples listed"

    r = await client.post("/api/admin/temples", headers=aa,
                          json={"name": "Kashi Vishwanath Annex", "city": "Varanasi",
                                "deity": "Shiva", "timings": "5:30 AM - 11:00 AM",
                                "descr": "Annex hall for special bookings.",
                                "pujas": ["rudra", "mrityunjaya"]})
    assert r.status_code == 201, r.text
    t = r.json()["temple"]
    assert t["id"]
    assert t["active"] == 1
    assert t["pujas"] == ["rudra", "mrityunjaya"]
    assert t["timings"] == "5:30 AM - 11:00 AM"
    assert t["n"] == "Kashi Vishwanath Annex"

    # unknown puja ids are dropped; an empty set is rejected
    empty = await client.post("/api/admin/temples", headers=aa,
                              json={"name": "No puja hall", "pujas": ["nosuch"]})
    assert empty.status_code == 400, "puja set required"

    # PATCH: rename, retimings, swap pujas
    p = await client.patch("/api/admin/temples/" + t["id"], headers=aa,
                           json={"name": "Kashi Annex II", "timings": "6:00 AM - 12:00 PM",
                                 "pujas": ["rudra"]})
    assert p.status_code == 200, p.text
    assert p.json()["temple"]["n"] == "Kashi Annex II"
    assert p.json()["temple"]["pujas"] == ["rudra"]

    # audits: create + update recorded with the new actions
    audits = (await client.get("/api/admin/audit?limit=300", headers=aa)).json()["entries"]
    assert any(a for a in audits if a["action"] == "temple.create" and a["entityId"] == t["id"])
    assert any(a for a in audits if a["action"] == "temple.update" and a["entityId"] == t["id"])

    # delete the fresh temple: no bookings reference it, so it goes; reason audited
    d = await client.request("DELETE", "/api/admin/temples/" + t["id"], headers=aa,
                             json={"reason": "Listed in error — never a real temple partner"})
    assert d.status_code == 200, d.text
    after = (await client.get("/api/admin/temples", headers=aa)).json()["temples"]
    assert all(x["id"] != t["id"] for x in after)
    audits2 = (await client.get("/api/admin/audit?limit=300", headers=aa)).json()["entries"]
    assert any(a for a in audits2 if a["action"] == "temple.delete" and a["entityId"] == t["id"]
               and "never a real temple" in (a["reason"] or ""))

    # access: customers and pandits never reach the CRUD surface
    ct = {"Authorization": "Bearer " + await login(client, "customer")}
    pt = {"Authorization": "Bearer " + await login(client, "pandit")}
    assert (await client.get("/api/admin/temples", headers=ct)).status_code == 403
    assert (await client.post("/api/admin/temples", headers=ct,
                              json={"name": "x", "pujas": ["rudra"]})).status_code == 403
    assert (await client.patch("/api/admin/temples/t1", headers=pt,
                               json={"name": "hax"})).status_code == 403
    assert (await client.delete("/api/admin/temples/t1", headers=pt)).status_code == 403


async def test_active_flag_gates_directory_and_bookings(client, db_session):
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    ct = await login(client, "customer")

    r = await _booking(client, ct)
    assert r.status_code == 201, r.text
    assert r.json()["booking"]["templeId"] == "t1", "temple booking created against a listed temple"

    # delist → hidden from the customer state, refused for NEW temple bookings
    off = await client.patch("/api/admin/temples/t1", headers=aa, json={"active": False})
    assert off.status_code == 200, off.text
    assert off.json()["temple"]["active"] == 0
    state = (await client.get("/api/state", headers={"Authorization": "Bearer " + ct})).json()
    assert all(x["id"] != "t1" for x in state["catalog"]["temples"]), "delisted temple hidden"
    refused = await _booking(client, ct, {"date": day_plus(22)})
    assert refused.status_code == 400, "temple-mode booking refused while delisted"

    # a puja offered ONLY by delisted temples is unavailable for temple mode
    t5 = await client.patch("/api/admin/temples/t5", headers=aa, json={"active": False})
    assert t5.status_code == 200, t5.text
    lakshmi_only = await client.post("/api/quote",
                                     json={"pujaId": "lakshmi", "mode": "temple",
                                           "date": day_plus(22), "slot": "10:00 AM"})
    assert lakshmi_only.status_code == 400, "temple mode unavailable when no active temple offers the puja"

    # delete with a booking reference → 409 with the deactivate pointer
    d = await client.delete("/api/admin/temples/t1", headers=aa)
    assert d.status_code == 409, d.text
    assert "Deactivate it instead" in d.json()["detail"]

    # relist → everything works again
    back = await client.patch("/api/admin/temples/t1", headers=aa, json={"active": True})
    assert back.json()["temple"]["active"] == 1
    await client.patch("/api/admin/temples/t5", headers=aa, json={"active": True})
    state2 = (await client.get("/api/state", headers={"Authorization": "Bearer " + ct})).json()
    assert any(x["id"] == "t1" for x in state2["catalog"]["temples"]), "relisted temple back"
    again = await _booking(client, ct, {"date": day_plus(23)})
    assert again.status_code == 201, "temple booking accepted after relisting"
    q = await client.post("/api/quote",
                          json={"pujaId": "lakshmi", "mode": "temple",
                                "date": day_plus(23), "slot": "10:00 AM"})
    assert q.status_code == 200, q.text

    # deleting the booking-less temple still works
    fresh = (await client.post("/api/admin/temples", headers=aa,
                               json={"name": "Ephemeral Shrine", "pujas": ["rudra"]})).json()["temple"]
    assert (await client.delete("/api/admin/temples/" + fresh["id"], headers=aa)).status_code == 200
