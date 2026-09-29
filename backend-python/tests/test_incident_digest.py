"""Repeat-reopen digest — Python twin of tests/incident-digest.test.js.

Incidents dismissed-and-reopened more than twice surface as an
Operations-tab review queue (GET /api/admin/incidents/reopen-digest,
?limit=N overrides the threshold); below-threshold incidents stay off."""
import pytest

from tests.conftest import admin_login, login

pytestmark = pytest.mark.asyncio


async def _booking(client, tok, date):
    r = await client.post("/api/bookings", headers={"Authorization": "Bearer " + tok},
                          json={"pujaId": "satyanarayan", "mode": "home", "date": date,
                                "slot": "10:00 AM",
                                "addr": {"line": "12 Test Street", "city": "Delhi NCR", "pin": "110001"},
                                "panditId": "p1", "sam": [], "pra": []})
    assert r.status_code == 201, r.text
    return r.json()["booking"]


async def _incident(client, pt, booking_id, category, description):
    r = await client.post("/api/pandit/incidents", headers={"Authorization": "Bearer " + pt},
                          json={"bookingId": booking_id, "category": category, "description": description})
    assert r.status_code == 201, r.text
    return r.json()["incident"]


async def _dismiss(client, aa, iid, reason):
    r = await client.patch(f"/api/admin/incidents/{iid}", headers=aa,
                           json={"status": "DISMISSED", "reason": reason})
    assert r.status_code == 200, r.text


async def _reopen(client, aa, iid, reason):
    return await client.post(f"/api/admin/incidents/{iid}/reopen", headers=aa, json={"reason": reason})


async def test_reopen_digest_threshold_ordering_and_access(client, db_session):
    import time

    pt = await login(client, "pandit")
    ct = await login(client, "customer")
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    day = lambda n: time.strftime("%Y-%m-%d", time.localtime(time.time() + n * 86400))

    # incident A: dismissed and reopened 3 times -> must appear
    bA = await _booking(client, ct, day(20))
    A = await _incident(client, pt, bA["id"], "SAFETY_CONCERN",
                        "Repeated access obstruction at the venue by the host.")
    for i in range(1, 4):
        await _dismiss(client, aa, A["id"], f"Dismissal pass {i} (documented).")
        re = await _reopen(client, aa, A["id"], f"Reopen {i}: new facts contradict dismissal {i}.")
        assert re.status_code == 200, re.text
        assert re.json()["incident"]["reopenCount"] == i

    # incident B: dismissed and reopened exactly 2 times -> must NOT appear
    bB = await _booking(client, ct, day(21))
    B = await _incident(client, pt, bB["id"], "CUSTOMER_CONDUCT",
                        "Customer conduct dispute at the second venue.")
    for i in range(1, 3):
        await _dismiss(client, aa, B["id"], f"Dismissal pass {i}.")
        await _reopen(client, aa, B["id"], f"Reopen {i}.")

    digest = await client.get("/api/admin/incidents/reopen-digest", headers=aa)
    assert digest.status_code == 200
    body = digest.json()
    assert body["threshold"] == 2
    ids = [x["id"] for x in body["incidents"]]
    assert A["id"] in ids, "3-reopen incident is on the queue"
    assert B["id"] not in ids, "2-reopen incident stays below the threshold"
    rowA = next(x for x in body["incidents"] if x["id"] == A["id"])
    assert rowA["reopenCount"] == 3
    assert rowA["status"] == "UNDER_REVIEW"
    assert rowA["reopenReason"] == "Reopen 3: new facts contradict dismissal 3."
    assert all(x["status"] in ("OPEN", "UNDER_REVIEW") for x in body["incidents"])

    # ?limit=N lowers the threshold for wider sweeps
    wide = await client.get("/api/admin/incidents/reopen-digest?limit=1", headers=aa)
    assert B["id"] in [x["id"] for x in wide.json()["incidents"]]

    # access: admin-only
    ct_h = {"Authorization": "Bearer " + ct}
    assert (await client.get("/api/admin/incidents/reopen-digest", headers=ct_h)).status_code == 403
    assert (await client.get("/api/admin/incidents/reopen-digest")).status_code == 401
