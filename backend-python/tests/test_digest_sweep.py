"""Daily reopen-digest sweep — Python twin of tests/digest-sweep.test.js.

The first sweep reports the current state (an existing backlog surfaces
without anyone opening Operations); an immediate repeat is silent; a new
queue entry and a newly flagged pandit re-alert; the notifications panel
surfaces digest lines."""
import time

import pytest
from sqlalchemy import select, update

from app.models import Lead, Notif
from app.services.digest_sweep import KEY, tick

from tests.conftest import admin_login, login

pytestmark = pytest.mark.asyncio

H = lambda tok: {"Authorization": "Bearer " + tok}


async def admin_alerts(db):
    rows = (await db.execute(
        select(Notif).where(Notif.channel == "In-App",
                            Notif.message.like("Daily reopen digest — %"))
        .order_by(Notif.ts.desc()))).scalars().all()
    return rows


async def test_digest_sweep_diff_and_notify(client, db_session):
    at = await admin_login(client)
    pt = await login(client, "pandit")
    ct = await login(client, "customer")
    aa = {"Authorization": "Bearer " + at}
    day = lambda n: time.strftime("%Y-%m-%d", time.localtime(time.time() + n * 86400))

    # empty state -> silent
    assert await tick(db_session) == 0, "no state -> no alerts"
    await db_session.commit()  # the caller commits (get_db / scheduler wrapper do)

    async def booking(d):
        r = await client.post("/api/bookings", headers=H(ct),
                              json={"pujaId": "satyanarayan", "mode": "home", "date": day(d),
                                    "slot": "10:00 AM",
                                    "addr": {"line": "12 Sweep Street", "city": "Delhi NCR", "pin": "110001"},
                                    "panditId": "p1", "sam": [], "pra": []})
        assert r.status_code == 201, r.text
        return r.json()["booking"]

    async def loop(b, tag, n):
        r = await client.post("/api/pandit/incidents", headers=H(pt),
                              json={"bookingId": b["id"], "category": "CUSTOMER_CONDUCT",
                                    "description": f"Sweep probe {tag}: conduct dispute during the puja."})
        assert r.status_code == 201, r.text
        iid = r.json()["incident"]["id"]
        for i in range(1, n + 1):
            d = await client.patch(f"/api/admin/incidents/{iid}", headers=aa,
                                   json={"status": "DISMISSED", "reason": f"{tag} dismissal {i}"})
            assert d.status_code == 200, d.text
            re = await client.post(f"/api/admin/incidents/{iid}/reopen", headers=aa,
                                   json={"reason": f"{tag} reopen {i}"})
            assert re.status_code == 200, re.text
        return iid

    b1 = await booking(41)
    b2 = await booking(42)
    b3 = await booking(43)
    i1 = await loop(b1, "A", 3)
    i2 = await loop(b2, "B", 1)
    i3 = await loop(b3, "C", 1)

    # baseline sweep reports the current state
    n1 = await tick(db_session)
    assert n1 > 0, "baseline sweep reports the current state to admins"
    await db_session.commit()
    rows = (await db_session.execute(
        select(Notif).where(Notif.channel == "In-App", Notif.message.like("Daily reopen digest — %")))).scalars().all()
    assert rows, "digest notifications stored"
    assert any("Flagged pandit" in n.message for n in rows), "digest names the flagged pandit"

    # immediate repeat: silent
    assert await tick(db_session) == 0, "repeat sweep with no change is silent"
    await db_session.commit()

    # new queue entry past the threshold re-alerts
    b4 = await booking(44)
    i4 = await loop(b4, "D", 3)
    n2 = await tick(db_session)
    assert n2 > 0, "new queue entries re-alert"
    await db_session.commit()
    rows2 = (await db_session.execute(
        select(Notif).where(Notif.channel == "In-App", Notif.message.like("Daily reopen digest — %"))
        .order_by(Notif.ts.desc()))).scalars().all()
    assert len(rows2) > len(rows), "a fresh digest notification was stored"
    assert any(f"Review queue entry: incident {i4}" in n.message for n in rows2), "digest names the new queue entry"
    assert await tick(db_session) == 0, "silent again after the diff is consumed"
    await db_session.commit()

    # settings snapshot persisted under the contract key
    from app.services.bookings import get_setting
    snap = await get_setting(db_session, KEY, None)
    assert snap and i4 in snap["queue"], "snapshot advanced with the new queue entry"

    # the ops panel (all_queue_alerts) surfaces digest lines
    panel = await client.get("/api/admin/incidents/queue-alerts", headers=aa)
    assert panel.status_code == 200
    assert any(a["message"].startswith("Daily reopen digest — ") for a in panel.json()["alerts"]), \
        "digest lines reach the notifications panel"

    # access: admin-only
    assert (await client.get("/api/admin/incidents/queue-alerts", headers=H(ct))).status_code == 403


async def test_due_lead_follow_up_alerts(client, db_session):
    """Twin of tests/digest-sweep.test.js: a lead whose follow-up date came due
    alerts once per follow-up — silent on repeat ticks, re-alerting only when
    the follow-up moves and comes due again, and the notifications panel
    surfaces the line."""
    at = await admin_login(client)
    aa = H(at)

    # a lead with a follow-up date already past is reported on the next tick
    r = await client.post("/api/admin/leads", headers=aa,
                          json={"source": "Other", "name": "Due Follower",
                                "mobile": "9876511001"})
    assert r.status_code == 201, r.text
    lid = r.json()["lead"]["id"]
    await db_session.execute(update(Lead).where(Lead.id == lid)
                             .values(follow_up_at=int(time.time() * 1000) - 3_600_000))
    await db_session.commit()

    assert await tick(db_session) > 0, "a due follow-up is reported to admins"
    await db_session.commit()
    from app.services.bookings import get_setting
    snap = await get_setting(db_session, KEY, None)
    assert snap and lid in snap["dueLeads"], "snapshot carries the due lead"

    # immediate repeat: silent (already reported)
    assert await tick(db_session) == 0, "repeat tick stays silent about the same follow-up"
    await db_session.commit()

    # rescheduling into the future clears the alert; coming due again re-alerts
    await db_session.execute(update(Lead).where(Lead.id == lid)
                             .values(follow_up_at=int(time.time() * 1000) + 86_400_000))
    await db_session.commit()
    assert await tick(db_session) == 0, "future follow-up is silent"
    await db_session.commit()
    snap = await get_setting(db_session, KEY, None)
    assert snap and lid not in snap["dueLeads"], "rescheduled lead left the due snapshot"

    await db_session.execute(update(Lead).where(Lead.id == lid)
                             .values(follow_up_at=int(time.time() * 1000) - 60_000))
    await db_session.commit()
    assert await tick(db_session) > 0, "re-due follow-up re-alerts"
    await db_session.commit()
    assert await tick(db_session) == 0, "silent again after the re-alert is consumed"
    await db_session.commit()

    # the ops panel surfaces the follow-up line (digest bullet lines included)
    panel = await client.get("/api/admin/incidents/queue-alerts", headers=aa)
    assert panel.status_code == 200
    assert any(f"Follow-up due: lead {lid}" in a["message"] for a in panel.json()["alerts"]), \
        "follow-up line reaches the notifications panel"

    # converting the lead takes it out of the pipeline — no more chasing
    await db_session.execute(update(Lead).where(Lead.id == lid).values(status="CONVERTED"))
    await db_session.commit()
    assert await tick(db_session) == 0, "converted lead leaves the due set silently"
    await db_session.commit()
    snap = await get_setting(db_session, KEY, None)
    assert snap and lid not in snap["dueLeads"], "converted lead is out of the snapshot"
