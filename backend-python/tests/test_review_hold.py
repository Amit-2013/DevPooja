"""Review hold for flagged-pandit bookings — Python twin of tests/review-hold.test.js.

While a pandit is flagged by the repeat-reopen digest (live incidents reopened
across DISTINCT bookings beyond REOPEN_LIMIT), their NEW bookings are stamped
with a review hold: the pandit cannot accept or start them until an admin
releases the booking or every live incident is resolved (auto-release)."""
import time

import pytest

from tests.conftest import admin_login, login

pytestmark = pytest.mark.asyncio

H = lambda tok: {"Authorization": "Bearer " + tok}


async def _booking(client, tok, date):
    r = await client.post("/api/bookings", headers=H(tok),
                          json={"pujaId": "satyanarayan", "mode": "home", "date": date,
                                "slot": "10:00 AM",
                                "addr": {"line": "12 Test Street", "city": "Delhi NCR", "pin": "110001"},
                                "panditId": "p1", "sam": [], "pra": []})
    assert r.status_code == 201, r.text
    return r.json()["booking"]


async def _incident(client, pt, booking_id, tag, n_reopens, aa):
    r = await client.post("/api/pandit/incidents", headers=H(pt),
                          json={"bookingId": booking_id, "category": "CUSTOMER_CONDUCT",
                                "description": f"Hold probe {tag}: conduct dispute during the puja."})
    assert r.status_code == 201, r.text
    iid = r.json()["incident"]["id"]
    for i in range(1, n_reopens + 1):
        d = await client.patch(f"/api/admin/incidents/{iid}", headers=aa,
                               json={"status": "DISMISSED", "reason": f"{tag} dismissal {i}"})
        assert d.status_code == 200, d.text
        re = await client.post(f"/api/admin/incidents/{iid}/reopen", headers=aa,
                               json={"reason": f"{tag} reopen {i}"})
        assert re.status_code == 200, re.text
    return iid


async def test_review_hold_lifecycle(client, db_session):
    pt = await login(client, "pandit")
    ct = await login(client, "customer")
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    day = lambda n: time.strftime("%Y-%m-%d", time.localtime(time.time() + n * 86400))

    # Build the cross-booking pattern: incidents on 3 distinct live bookings
    b1 = await _booking(client, ct, day(25))
    b2 = await _booking(client, ct, day(26))
    b3 = await _booking(client, ct, day(27))
    await _incident(client, pt, b1["id"], "X1", 3, aa)
    await _incident(client, pt, b2["id"], "X2", 1, aa)
    await _incident(client, pt, b3["id"], "X3", 1, aa)
    digest = (await client.get("/api/admin/incidents/reopen-digest", headers=aa)).json()
    assert any(x["panditId"] == "p1" for x in digest["flaggedPandits"]), "p1 is flagged now"

    # admin creates a manual booking and assigns it to the flagged pandit -> hold stamps
    r = await client.post("/api/admin/bookings/manual", headers=aa,
                          json={"name": "Hold Probe", "mobile": "9876511001", "pujaId": "lakshmi",
                                "mode": "home", "slot": "10:00 AM", "date": day(30)})
    assert r.status_code == 201, r.text
    bk = r.json()["booking"]
    r = await client.post(f"/api/admin/bookings/{bk['id']}/assign", headers=aa, json={"panditId": "p1"})
    assert r.status_code == 200, r.text
    stamped = (await client.get("/api/state", headers=aa)).json()["bookings"]
    row = next(x for x in stamped if x["id"] == bk["id"])
    assert row["reviewHold"] is True, "assigned booking is stamped with the review hold"
    assert "flagged" in row["holdReason"], "hold reason explains the flag"

    # the customer-created booking to the flagged pandit also holds (created while flagged)
    b4 = await _booking(client, ct, day(28))
    assert b4["reviewHold"] is True, "customer booking to flagged pandit holds"

    # guard: pandit cannot accept the held booking
    refuse = await client.post(f"/api/pandit/bookings/{b4['id']}/accept", headers=H(pt), json={})
    assert refuse.status_code == 409, refuse.text
    assert "review hold" in refuse.json()["detail"], "the refusal explains the hold"

    # non-held bookings keep working (b2 predates the flag)
    rows = (await client.get("/api/state", headers=aa)).json()["bookings"]
    assert next(x for x in rows if x["id"] == b2["id"])["reviewHold"] is False

    # admin release: frees the booking and notifies the pandit
    rel = await client.post(f"/api/admin/bookings/{b4['id']}/release-hold", headers=aa, json={})
    assert rel.status_code == 200, rel.text
    assert rel.json()["released"] is True
    assert rel.json()["booking"]["reviewHold"] is False
    ok = await client.post(f"/api/pandit/bookings/{b4['id']}/accept", headers=H(pt), json={})
    assert ok.status_code == 200, "pandit can accept after release"
    again = await client.post(f"/api/admin/bookings/{b4['id']}/release-hold", headers=aa, json={})
    assert again.json()["released"] is False, "releasing a clean booking is a no-op"

    # auto-release: resolving every live incident clears the flag; the digest sweep frees the rest
    rows = (await client.get("/api/admin/incidents", headers=aa)).json()["incidents"]
    live = [x for x in rows if x["panditId"] == "p1" and (x.get("reopenCount") or 0) > 0
            and x["status"] in ("OPEN", "UNDER_REVIEW")]
    for r0 in live:
        d = await client.patch(f"/api/admin/incidents/{r0['id']}", headers=aa,
                               json={"status": "RESOLVED", "resolution": "Hold probe closed."})
        assert d.status_code == 200, d.text
    after = (await client.get("/api/admin/incidents/reopen-digest", headers=aa)).json()
    assert not any(x["panditId"] == "p1" for x in after["flaggedPandits"]), "flag cleared after resolving"
    remaining = [x for x in (await client.get("/api/state", headers=aa)).json()["bookings"]
                 if x["panditId"] == "p1" and x["reviewHold"]]
    assert remaining == [], "all held bookings auto-released"

    # access: admin-only release
    assert (await client.post(f"/api/admin/bookings/{b1['id']}/release-hold",
                              headers=H(ct), json={})).status_code == 403
