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


async def test_queue_entry_notifications(client, db_session):
    """Admins are notified in-app (existing In-App channel) when a reopen pushes
    an incident onto the repeat-reopen review queue; the drill-in endpoint
    returns the alert history per incident; below-threshold reopens never alert."""
    import time

    from sqlalchemy import select

    from app.models import Notif, User

    pt = await login(client, "pandit")
    ct = await login(client, "customer")
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    day = lambda n: time.strftime("%Y-%m-%d", time.localtime(time.time() + n * 86400))

    async def admin_alerts():
        rows = (await db_session.execute(
            select(Notif).join(User, User.id == Notif.user_id)
            .where(User.role == "admin", Notif.channel == "In-App")
            .order_by(Notif.ts.desc()))).scalars().all()
        return [n for n in rows if n.message.startswith("Repeat-reopen alert:")]

    b = await _booking(client, ct, day(22))
    inc = await _incident(client, pt, b["id"], "SAFETY_CONCERN",
                          "Escalating conduct issue at the venue entrance.")

    # reopens 1 and 2 stay at/below the threshold: no alerts
    for i in range(1, 3):
        await _dismiss(client, aa, inc["id"], f"Pass {i}.")
        re = await _reopen(client, aa, inc["id"], f"Reopen {i}.")
        assert re.status_code == 200, re.text
    assert all(n.message.startswith(f"Repeat-reopen alert: incident {inc['id']} ")
               is False for n in await admin_alerts()), "no queue-entry alerts below the threshold"

    # reopen 3 crosses the threshold: admins notified through the In-App channel
    await _dismiss(client, aa, inc["id"], "Pass 3.")
    r3 = await _reopen(client, aa, inc["id"], "Reopen 3: the third pass makes a pattern.")
    assert r3.status_code == 200
    assert r3.json()["incident"]["reopenCount"] == 3
    alerts = [n for n in await admin_alerts() if n.message.startswith(f"Repeat-reopen alert: incident {inc['id']} ")]
    assert len(alerts) >= 1, "admins notified on crossing the threshold"
    assert all("3 reopens, threshold 2" in n.message for n in alerts), "alert carries count + threshold"

    # a second crossing reopen alerts again — a fresh queue entry each time
    await _dismiss(client, aa, inc["id"], "Pass 4.")
    await _reopen(client, aa, inc["id"], "Reopen 4.")
    after = [n for n in await admin_alerts() if n.message.startswith(f"Repeat-reopen alert: incident {inc['id']} ")]
    assert len(after) == len(alerts) + 1, "exactly one new alert per crossing reopen"

    # drill-in endpoint returns this incident's alerts, newest first, admin-only
    drill = await client.get(f"/api/admin/incidents/{inc['id']}/queue-alerts", headers=aa)
    assert drill.status_code == 200
    body = drill.json()["alerts"]
    assert len(body) >= 2
    assert all(a["message"].startswith(f"Repeat-reopen alert: incident {inc['id']} ") for a in body)
    assert body[0]["ts"] >= body[-1]["ts"], "newest first"

    # access: admin-only
    assert (await client.get(f"/api/admin/incidents/{inc['id']}/queue-alerts",
                             headers={"Authorization": "Bearer " + ct})).status_code == 403
    assert (await client.get(f"/api/admin/incidents/{inc['id']}/queue-alerts")).status_code == 401


async def test_per_pandit_flagging_across_distinct_bookings(client, db_session):
    """Per-pandit flagging: a pandit whose live incidents were reopened across
    DISTINCT bookings beyond the threshold is flagged (reopens on one booking
    collapse to one — a single-booking loop never flags on volume alone);
    resolving every live incident drops the pandit off the flag list.
    Python twin of tests/incident-digest.test.js."""
    import time

    pt = await login(client, "pandit")
    ct = await login(client, "customer")
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    day = lambda n: time.strftime("%Y-%m-%d", time.localtime(time.time() + n * 86400))

    async def reopen_twice(booking_id, tag):
        inc = await _incident(client, pt, booking_id, "CUSTOMER_CONDUCT",
                              f"Pattern probe: {tag} — conduct dispute during the puja.")
        for i in (1, 2):
            await _dismiss(client, aa, inc["id"], f"{tag} dismissal {i}.")
            re = await _reopen(client, aa, inc["id"], f"{tag} reopen {i}.")
            assert re.status_code == 200, re.text
        return inc

    async def reopen_once(booking_id, tag):
        inc = await _incident(client, pt, booking_id, "OTHER",
                              f"Pattern probe: {tag} — one-off dispute, documented.")
        await _dismiss(client, aa, inc["id"], f"{tag} dismissal.")
        re = await _reopen(client, aa, inc["id"], f"{tag} reopen.")
        assert re.status_code == 200, re.text
        return inc

    # cross-booking pattern (X1+X2), a single-booking loop (S1: 3 reopens on ONE
    # booking — volume without breadth), and a below-threshold lone reopen (L1)
    b1 = await _booking(client, ct, day(30))
    b2 = await _booking(client, ct, day(31))
    b3 = await _booking(client, ct, day(32))
    b4 = await _booking(client, ct, day(33))
    await reopen_twice(b1["id"], "X1")                      # 2 reopens
    await reopen_once(b2["id"], "X2")                       # 2+1 = 3 reopens over 2 distinct bookings
    single = await reopen_twice(b3["id"], "S1")
    await _dismiss(client, aa, single["id"], "S1 dismissal 3.")
    await _reopen(client, aa, single["id"], "S1 reopen 3.")  # 3 reopens, ONE booking
    await reopen_once(b4["id"], "L1")                       # 1 reopen: below everything

    digest = await client.get("/api/admin/incidents/reopen-digest", headers=aa)
    assert digest.status_code == 200
    flagged = digest.json()["flaggedPandits"]
    assert isinstance(flagged, list), "digest carries flaggedPandits"
    p1 = next((x for x in flagged if x["panditId"] == "p1"), None)
    assert p1, "pandit p1 flagged: reopens cross the threshold over distinct bookings"
    assert p1["bookings"] >= 3, "distinct bookings collapsed (X1, X2, S1, L1)"
    assert p1["incidents"] >= 4, "incident count distinct from booking count"
    assert p1["reopens"] >= 7, "total reopen count summed across incidents"

    # ?limit=1 narrows the window: same shape
    wide = await client.get("/api/admin/incidents/reopen-digest?limit=1", headers=aa)
    assert wide.status_code == 200
    assert isinstance(wide.json()["flaggedPandits"], list), "limit=1 keeps the flaggedPandits shape"

    # resolved incidents leave the live queue: resolve everything for p1
    live = [x for x in (await client.get("/api/admin/incidents", headers=aa)).json()["incidents"]
            if x["panditId"] == "p1" and (x.get("reopenCount") or 0) > 0
            and x["status"] in ("OPEN", "UNDER_REVIEW")]
    assert live, "setup left live reopened incidents for p1"
    for row in live:
        r = await client.patch(f"/api/admin/incidents/{row['id']}", headers=aa,
                               json={"status": "RESOLVED", "resolution": "Pattern reviewed and closed out."})
        assert r.status_code == 200, r.text
    after = (await client.get("/api/admin/incidents/reopen-digest", headers=aa)).json()["flaggedPandits"]
    assert not any(x["panditId"] == "p1" for x in after), "fully-resolved pandit drops off the flag list"

    # access: admin-only
    ct_h = {"Authorization": "Bearer " + ct}
    assert (await client.get("/api/admin/incidents/reopen-digest", headers=ct_h)).status_code == 403
    assert (await client.get("/api/admin/incidents/reopen-digest")).status_code == 401
