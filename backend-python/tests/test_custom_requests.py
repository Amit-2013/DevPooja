"""Python twin of tests/api.test.js 'customised puja request: public submit,
admin queue, convert to puja' — the public POST /api/custom-puja intake, the
admin queue (review + status history), access control, and the convert-to-
catalogue step that turns an approved request into a hidden puja.

This closes the parity gap MASTER-AUDIT recorded: the model existed in
backend-python all along, but no FastAPI route ever served it."""
import pytest

pytestmark = pytest.mark.asyncio


async def _admin_headers(client) -> dict:
    r = await client.post("/api/auth/admin",
                          json={"email": "admin@daivikpuja.in", "password": "admin123"})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}


async def _login(client, role: str) -> str:
    r = await client.post("/api/auth/demo", json={"role": role})
    assert r.status_code == 200, r.text
    return r.json()["token"]


async def test_custom_puja_public_submit_admin_queue_convert(client):
    # the public form validates before it ever reaches the queue
    bad = await client.post("/api/custom-puja", json={"name": "X", "mobile": "123"})
    assert bad.status_code == 400, bad.text
    no_name = await client.post("/api/custom-puja", json={"mobile": "9876500022"})
    assert no_name.status_code == 400, no_name.text

    ok = await client.post("/api/custom-puja", json={
        "name": "Custom Devotee", "mobile": "9876567890",
        "purpose": "Special griha shanti", "deity": "Shiva", "city": "Pune",
        "budget": 6000, "notes": "Family tradition, north-Indian vidhi"})
    assert ok.status_code == 201, ok.text
    assert ok.json()["ok"] is True and ok.json()["id"].startswith("CR")

    aa = await _admin_headers(client)

    # a customer must not see the operations queue
    ct = {"Authorization": "Bearer " + await _login(client, "customer")}
    assert (await client.get("/api/admin/custom-requests", headers=ct)).status_code == 403
    assert (await client.get("/api/admin/custom-requests")).status_code == 401

    r = await client.get("/api/admin/custom-requests", headers=aa)
    assert r.status_code == 200, r.text
    req = next((x for x in r.json()["requests"] if x["name"] == "Custom Devotee"), None)
    assert req, "request landed in the admin queue"
    assert req["status"] == "NEW"
    assert req["budget"] == 6000 and req["city"] == "Pune"

    # the status filter narrows the queue (unknown status -> empty, Node parity)
    fresh = await client.get("/api/admin/custom-requests?status=NEW", headers=aa)
    assert any(x["id"] == req["id"] for x in fresh.json()["requests"])
    empty = await client.get("/api/admin/custom-requests?status=NO_SUCH", headers=aa)
    assert empty.json()["requests"] == []

    # review it, with history
    p = await client.patch(f"/api/admin/custom-requests/{req['id']}", headers=aa,
                           json={"status": "UNDER_REVIEW", "adminNotes": "Called, confirmed details"})
    assert p.status_code == 200, p.text
    assert p.json() == {"ok": True}
    reviewed = next(x for x in (await client.get("/api/admin/custom-requests",
                                                 headers=aa)).json()["requests"]
                    if x["id"] == req["id"])
    assert any("UNDER_REVIEW" in str(h[0]) for h in reviewed["history"]), "status history tracked"
    assert reviewed["adminNotes"] == "Called, confirmed details"
    assert reviewed["updatedAt"], "updated_at stamped on the patch"

    # an unknown status is refused outright
    assert (await client.patch(f"/api/admin/custom-requests/{req['id']}", headers=aa,
                               json={"status": "WAT"})).status_code == 400
    assert (await client.patch("/api/admin/custom-requests/CRnope9", headers=aa,
                               json={"status": "APPROVED"})).status_code == 404

    # convert: the request becomes a real (hidden) catalog entry
    conv = await client.post(f"/api/admin/custom-requests/{req['id']}/convert", headers=aa,
                             json={"name": "Special Griha Shanti", "hindi": "विशेष गृह शांति",
                                   "price": 5500})
    assert conv.status_code == 201, conv.text
    puja_id = conv.json()["pujaId"]
    assert conv.json()["ok"] is True and puja_id

    st = (await client.get("/api/state", headers=aa)).json()
    made = next((p for p in st["catalog"]["pujas"] if p["id"] == puja_id), None)
    assert made, "the converted puja is in the catalog"
    assert made["price"] == 5500, "price carried over"
    assert made["hidden"] is True, "stays hidden until an operator unmasks it"

    done = next(x for x in (await client.get("/api/admin/custom-requests",
                                             headers=aa)).json()["requests"]
                if x["id"] == req["id"])
    assert done["status"] == "SCHEDULED", "conversion schedules the request"
    assert done["pujaId"] == puja_id, "the request points at the puja it became"
    assert any("Converted to puja" in str(h[0]) for h in done["history"])


async def test_custom_puja_signed_in_request_is_linked_to_the_account(client):
    """Optional auth: a signed-in devotee is linked, a guest is not."""
    tok = await _login(client, "customer")
    guest = await client.post("/api/custom-puja",
                              json={"name": "Guest Devotee", "mobile": "9876500033"})
    assert guest.status_code == 201
    signed = await client.post("/api/custom-puja",
                               json={"name": "Linked Devotee", "mobile": "9876500044"},
                               headers={"Authorization": "Bearer " + tok})
    assert signed.status_code == 201

    aa = await _admin_headers(client)
    rows = {x["id"]: x for x in (await client.get("/api/admin/custom-requests",
                                                  headers=aa)).json()["requests"]}
    assert rows[guest.json()["id"]]["userId"] is None, "a guest lands unlinked"
    assert rows[signed.json()["id"]]["userId"], "a session links the request to its owner"
