"""Phase 3 tests: centralized availability calendar — Python twin of the Node
'availability calendar' suite in tests/api.test.js."""
import time

import pytest

pytestmark = pytest.mark.asyncio


def _day_plus(n: int) -> str:
    d = time.localtime(time.time() + n * 86400)
    return time.strftime("%Y-%m-%d", d)


def _wd(iso_date: str) -> int:
    from datetime import datetime

    d = datetime.fromisoformat(iso_date + "T12:00:00+00:00")
    return (d.weekday() + 1) % 7  # JS getUTCDay parity


async def _login(client, role: str) -> str:
    r = await client.post("/api/auth/demo", json={"role": role})
    assert r.status_code == 200, r.text
    return r.json()["token"]


async def test_calendar_rules_block_and_restore(client):
    day_plus = _day_plus

    cust = await _login(client, "customer")
    pandit = await _login(client, "pandit")
    pa = {"Authorization": f"Bearer {pandit}"}
    ca = {"Authorization": f"Bearer {cust}"}
    day = day_plus(30)
    wd = _wd(day)

    # Default config is permissive.
    cal0 = (await client.get("/api/pandit/calendar", headers=pa)).json()["calendar"]
    assert cal0["weeklyOff"] == [] and cal0["radiusKm"] is None and cal0["onlineEnabled"] is True

    body = {"pujaId": "lakshmi", "mode": "home", "date": day, "slot": "10:00 AM",
            "addr": {"line": "12 Test Street", "city": "Delhi NCR", "pin": "110001"},
            "panditId": "p1", "sam": [], "pra": []}

    # Weekly off blocks the whole weekday.
    r = await client.put("/api/pandit/calendar", json={"weeklyOff": [wd]}, headers=pa)
    assert r.json()["calendar"]["weeklyOff"] == [wd]
    b = await client.post("/api/bookings", json=body, headers=ca)
    assert b.status_code == 409 and "weekly off" in b.json()["detail"].lower()

    # Holiday blocks a single date.
    await client.put("/api/pandit/calendar", json={"weeklyOff": []}, headers=pa)
    r = await client.post("/api/pandit/calendar/dates", json={"date": day, "kind": "holiday"}, headers=pa)
    assert day in r.json()["calendar"]["holidays"]
    b = await client.post("/api/bookings", json=body, headers=ca)
    assert b.status_code == 409 and "holiday" in b.json()["detail"].lower()

    # Blocked date carries a reason.
    await client.post("/api/pandit/calendar/dates", json={"date": day, "kind": "holiday"}, headers=pa)
    r = await client.post("/api/pandit/calendar/dates",
                          json={"date": day, "kind": "blocked", "reason": "Family function"}, headers=pa)
    assert any(x["date"] == day and x["reason"] == "Family function" for x in r.json()["calendar"]["blockedDates"])
    b = await client.post("/api/bookings", json=body, headers=ca)
    assert b.status_code == 409 and "family function" in b.json()["detail"].lower()

    # Slot restriction.
    await client.post("/api/pandit/calendar/dates", json={"date": day, "kind": "blocked"}, headers=pa)
    await client.put("/api/pandit/calendar", json={"slots": ["06:00 AM"]}, headers=pa)
    b = await client.post("/api/bookings", json=body, headers=ca)
    assert b.status_code == 409 and "slot" in b.json()["detail"].lower()
    await client.put("/api/pandit/calendar", json={"slots": []}, headers=pa)

    # Online capability flag.
    await client.put("/api/pandit/calendar", json={"onlineEnabled": False}, headers=pa)
    b = await client.post("/api/bookings",
                          json={**body, "mode": "online", "date": day_plus(3)},
                          headers=ca)
    assert b.status_code == 409 and "online" in b.json()["detail"].lower()
    await client.put("/api/pandit/calendar", json={"onlineEnabled": True}, headers=pa)

    # Temple capability flag (rudra is temple-offered; t1 offers it).
    await client.put("/api/pandit/calendar", json={"templeEnabled": False}, headers=pa)
    b = await client.post("/api/bookings",
                          json={**body, "pujaId": "rudra", "mode": "temple", "templeId": "t1",
                                "date": day_plus(3)},
                          headers=ca)
    assert b.status_code == 409 and "temple services" in b.json()["detail"].lower()
    await client.put("/api/pandit/calendar", json={"templeEnabled": True}, headers=pa)

    # Home radius: p1 based in Delhi; Chennai is far outside 50 km.
    r = await client.put("/api/pandit/calendar", json={"radiusKm": 50, "baseCity": "Delhi NCR"}, headers=pa)
    assert r.json()["calendar"]["radiusKm"] == 50
    b = await client.post("/api/bookings",
                          json={**body, "date": day_plus(3),
                                "addr": {"line": "1 Marina Beach Rd", "city": "Chennai", "pin": "600005"}},
                          headers=ca)
    assert b.status_code == 409 and "service radius" in b.json()["detail"].lower()

    # why endpoint explains the verdict.
    why = (await client.get(f"/api/pandit/calendar/why?date={day_plus(3)}&slot=10:00%20AM&mode=home",
                            headers=pa)).json()["verdict"]
    assert why["ok"] is False and why["code"] == "RADIUS"

    # Customer-facing availability list respects the same rules.
    avail = (await client.get(
        f"/api/pandits/available?date={day_plus(3)}&slot=10:00%20AM&mode=home&city=Chennai",
        headers=ca)).json()["pandits"]
    assert all(p["id"] != "p1" for p in avail), "p1 excluded outside its radius"
    assert any(p["id"] == "p2" for p in avail), "Chennai pandit available"

    # Restore permissive defaults; bookable again.
    await client.put("/api/pandit/calendar",
                     json={"weeklyOff": [], "slots": [], "onlineEnabled": True,
                           "templeEnabled": True, "radiusKm": None}, headers=pa)
    ok = await client.post("/api/bookings", json={**body, "date": day_plus(31)}, headers=ca)
    assert ok.status_code in (200, 201), ok.text
