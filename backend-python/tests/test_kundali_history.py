"""Phase 15: kundali history — /mine filters (?billing/?kind/?q), myKundalis in
the customer state payload, and the admin /admin/kundalis list with the same
filters (Node-parity additions; mirrors tests/api.test.js sections 5b/7b)."""
import pytest

from .conftest import admin_login, login

BIRTH = {"name": "History Tester", "dob": "1990-01-15", "tob": "10:30",
         "place": {"city": "Delhi", "state": "Delhi", "country": "India",
                   "lat": 28.6139, "lon": 77.2090, "tz": "Asia/Kolkata"},
         "save": False}


async def test_mine_filters(client):
    token = await login(client, "customer")
    h = {"Authorization": f"Bearer {token}"}
    r1 = await client.post("/api/kundali/generate", json=BIRTH, headers=h)
    assert r1.status_code == 201
    f = await client.post("/api/me/family", json={
        "relationship": "Mother", "name": "History Mata", "gender": "female",
        "dob": "1965-03-10", "tob": "06:15",
        "city": "Varanasi", "lat": 25.3176, "lon": 82.9739}, headers=h)
    assert f.status_code == 201, f.text
    r2 = await client.post("/api/kundali/generate",
                           json={**BIRTH, "familyMemberId": f.json()["id"]}, headers=h)
    assert r2.status_code == 201, r2.text
    self_id, fam_id = r1.json()["kundaliId"], r2.json()["kundaliId"]

    mine = (await client.get("/api/kundali/mine", headers=h)).json()["kundalis"]
    assert {self_id, fam_id} <= {k["kundaliId"] for k in mine}

    paid = (await client.get("/api/kundali/mine", params={"billing": "PAID"},
                             headers=h)).json()["kundalis"]
    assert paid and all(k["billing"] == "PAID" for k in paid)
    assert fam_id in {k["kundaliId"] for k in paid}

    fam = (await client.get("/api/kundali/mine", params={"kind": "family"},
                            headers=h)).json()["kundalis"]
    assert {k["kundaliId"] for k in fam} == {fam_id}

    per = (await client.get("/api/kundali/mine", params={"kind": "personal"},
                            headers=h)).json()["kundalis"]
    assert self_id in {k["kundaliId"] for k in per}
    assert fam_id not in {k["kundaliId"] for k in per}

    q1 = (await client.get("/api/kundali/mine", params={"q": "history"},
                           headers=h)).json()["kundalis"]
    assert q1 and all("history" in k["name"].lower() for k in q1)
    q2 = (await client.get("/api/kundali/mine", params={"q": "zz-nothing"},
                           headers=h)).json()["kundalis"]
    assert q2 == []


async def test_state_carries_my_kundalis(client):
    token = await login(client, "customer")
    h = {"Authorization": f"Bearer {token}"}
    r = await client.post("/api/kundali/generate", json=BIRTH, headers=h)
    st = (await client.get("/api/state", headers=h)).json()
    rows = st["myKundalis"]
    assert rows and rows[0]["kundaliId"] == r.json()["kundaliId"]
    assert set(rows[0]) == {"kundaliId", "name", "relationship", "billing", "price",
                            "gst", "final", "paymentStatus", "orderId", "createdAt"}
    # other roles never carry the key (Node parity)
    at = await admin_login(client)
    st_admin = (await client.get("/api/state",
                                 headers={"Authorization": f"Bearer {at}"})).json()
    assert "myKundalis" not in st_admin


async def test_admin_kundalis_filters(client):
    token = await login(client, "customer")
    h = {"Authorization": f"Bearer {token}"}
    await client.post("/api/kundali/generate", json=BIRTH, headers=h)
    f = await client.post("/api/me/family", json={
        "relationship": "Spouse", "name": "History Spouse", "gender": "female",
        "dob": "1992-08-01", "tob": "07:45",
        "city": "Jaipur", "lat": 26.9124, "lon": 75.7873}, headers=h)
    assert f.status_code == 201, f.text
    r2 = await client.post("/api/kundali/generate",
                           json={**BIRTH, "familyMemberId": f.json()["id"]}, headers=h)
    assert r2.status_code == 201, r2.text
    fam_id = r2.json()["kundaliId"]

    at = await admin_login(client)
    ah = {"Authorization": f"Bearer {at}"}
    all_rows = (await client.get("/api/admin/kundalis", headers=ah)).json()["kundalis"]
    assert fam_id in {k["kundaliId"] for k in all_rows}
    row = next(k for k in all_rows if k["kundaliId"] == fam_id)
    assert row["customer"] == "Asha Sharma" and row["mobile"] == "9811100001"
    assert row["relationship"] == "Spouse"
    assert row["billing"] in ("PAID", "PENDING_PAYMENT")

    fam = (await client.get("/api/admin/kundalis", params={"kind": "family"},
                            headers=ah)).json()["kundalis"]
    assert {k["kundaliId"] for k in fam} == {fam_id}
    per = (await client.get("/api/admin/kundalis", params={"kind": "personal"},
                            headers=ah)).json()["kundalis"]
    assert fam_id not in {k["kundaliId"] for k in per}
    q = (await client.get("/api/admin/kundalis", params={"q": "9811100001"},
                          headers=ah)).json()["kundalis"]
    assert fam_id in {k["kundaliId"] for k in q}
    assert all(k["mobile"] == "9811100001" for k in q)
    qn = (await client.get("/api/admin/kundalis", params={"q": "asha"},
                           headers=ah)).json()["kundalis"]
    assert fam_id in {k["kundaliId"] for k in qn}
    qb = (await client.get("/api/admin/kundalis", params={"q": "zz-nothing"},
                           headers=ah)).json()["kundalis"]
    assert qb == []
    # customers cannot call the admin list
    assert (await client.get("/api/admin/kundalis", headers=h)).status_code == 403
