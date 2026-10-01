"""Phases 27-29 — Communication engine: Python twin of tests/comms.test.js.

Covers: the campaign lifecycle state machine (DRAFT → SCHEDULED → SENDING →
SENT | FAILED, CANCELLED only from not-yet-sent), the only-DRAFT edit guard,
consent-skips with delivery rows, audience resolution, the due-campaign sweep,
/push through the engine, and the stateless Excel import (preview → commit →
re-preview dedupe) with bad-file rejection and access control.
"""
import io
import json
import time

import pytest
from openpyxl import Workbook

from app.models import Campaign, Lead, NotificationDelivery, User
from tests.conftest import admin_login, login

pytestmark = pytest.mark.asyncio

H = lambda tok: {"Authorization": "Bearer " + tok}


def _xlsx(rows) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.append(rows[0])
    for r in rows[1:]:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


async def _mk_customer(db, uid, name, mobile, email, pref=None):
    db.add(User(id=uid, role="customer", name=name, mobile=mobile, email=email,
                pref=json.dumps(pref or {}), joined="2026-01-01", created_at=1))


async def test_campaign_lifecycle(client, db_session):
    at = await admin_login(client)
    # create -> DRAFT
    r = await client.post("/api/admin/campaigns", headers=H(at),
                          json={"name": "Diwali blast", "channel": "In-App",
                                "audience": "All customers", "message": "Happy Diwali!"})
    assert r.status_code == 201, r.text
    c = r.json()["campaign"]
    assert c["status"] == "DRAFT"
    cid = c["id"]

    # edit while DRAFT works
    r = await client.patch(f"/api/admin/campaigns/{cid}", headers=H(at), json={"message": "Diwali 20% off"})
    assert r.status_code == 200, r.text
    assert r.json()["campaign"]["message"] == "Diwali 20% off"

    # schedule -> SCHEDULED; edits lock
    when = int(time.time() * 1000) + 3600000
    r = await client.post(f"/api/admin/campaigns/{cid}/schedule", headers=H(at),
                          json={"scheduledAt": when})
    assert r.status_code == 200, r.text
    assert r.json()["campaign"]["status"] == "SCHEDULED"
    r = await client.patch(f"/api/admin/campaigns/{cid}", headers=H(at), json={"name": "nope"})
    assert r.status_code == 409, "edit after schedule blocked"

    # early manual send allowed, finishes the lifecycle
    r = await client.post(f"/api/admin/campaigns/{cid}/send", headers=H(at), json={})
    assert r.status_code == 200, r.text
    assert r.json()["campaign"]["status"] == "SENT"
    assert r.json()["campaign"]["sent"] >= 1
    r = await client.post(f"/api/admin/campaigns/{cid}/send", headers=H(at), json={})
    assert r.status_code == 409, "re-send blocked"
    r = await client.post(f"/api/admin/campaigns/{cid}/cancel", headers=H(at), json={})
    assert r.status_code == 409, "cancel after send blocked"

    # detail aggregates delivery records
    r = await client.get(f"/api/admin/campaigns/{cid}", headers=H(at))
    assert r.status_code == 200, r.text
    assert r.json()["deliveries"]["SENT"] == r.json()["campaign"]["sent"]


async def test_consent_skips_record_reasons(client, db_session):
    await _mk_customer(db_session, "xc1", "Wa Optout", "9700000001", "xc1@t.in", {"wa": False})
    await _mk_customer(db_session, "xc2", "No Mobile", None, "xc2@t.in")
    await db_session.commit()
    at = await admin_login(client)
    r = await client.post("/api/admin/campaigns", headers=H(at),
                          json={"name": "Wa blast", "channel": "WhatsApp",
                                "audience": "All customers", "message": "Namaste"})
    assert r.status_code == 201, r.text
    cid = r.json()["campaign"]["id"]
    r = await client.post(f"/api/admin/campaigns/{cid}/send", headers=H(at), json={})
    assert r.status_code == 200, r.text
    rows = (await db_session.execute(
        NotificationDelivery.__table__.select().where(
            NotificationDelivery.campaign_id == cid,
            NotificationDelivery.user_id.in_(("xc1", "xc2"))))).mappings().all()
    assert len(rows) == 2, "opt-out and no-target customers still get delivery rows"
    assert any(x["status"] == "SKIPPED" and "opted out" in (x["detail"] or "") for x in rows)
    assert any(x["status"] == "SKIPPED" and "target" in (x["detail"] or "") for x in rows)


async def test_plus_audience_resolution(client, db_session):
    await _mk_customer(db_session, "xp1", "Plus One", "9700000011", "xp1@t.in")
    await db_session.execute(User.__table__.update().where(User.id == "xp1").values(plus=1))
    await db_session.commit()
    at = await admin_login(client)
    r = await client.post("/api/admin/campaigns", headers=H(at),
                          json={"name": "Plus perks", "channel": "In-App",
                                "audience": "Plus members", "message": "Perks inside"})
    cid = r.json()["campaign"]["id"]
    r = await client.post(f"/api/admin/campaigns/{cid}/send", headers=H(at), json={})
    assert r.status_code == 200, r.text
    rows = (await db_session.execute(
        NotificationDelivery.__table__.select().where(
            NotificationDelivery.campaign_id == cid))).mappings().all()
    assert rows, "plus customers targeted"
    for x in rows:
        assert (await db_session.get(User, x["user_id"])).plus == 1, "only plus members targeted"


async def test_cancelled_never_sends_and_due_sweep_fires(client, db_session):
    at = await admin_login(client)
    # cancelled never sends
    r = await client.post("/api/admin/campaigns", headers=H(at),
                          json={"name": "Later", "channel": "In-App",
                                "audience": "All customers", "message": "Coming soon"})
    cid = r.json()["campaign"]["id"]
    await client.post(f"/api/admin/campaigns/{cid}/schedule", headers=H(at),
                      json={"scheduledAt": int(time.time() * 1000) + 86400000})
    r = await client.post(f"/api/admin/campaigns/{cid}/cancel", headers=H(at), json={"reason": "Wrong audience selected"})
    assert r.json()["campaign"]["status"] == "CANCELLED"
    r = await client.post("/api/admin/campaigns/due-sweep", headers=H(at), json={})
    assert r.json()["sent"] == 0, "cancelled never sends"
    audits = (await client.get("/api/admin/audit?limit=300", headers=H(at))).json()["entries"]
    assert any(a["action"] == "campaign.cancelled" and "Wrong audience" in (a["reason"] or "") for a in audits), \
        "cancel reason audited"

    # past-due (server was down past scheduled_at) fires on the sweep
    r = await client.post("/api/admin/campaigns", headers=H(at),
                          json={"name": "Down then due", "channel": "In-App",
                                "audience": "Plus members", "message": "Sweep fired me"})
    cid2 = r.json()["campaign"]["id"]
    await client.post(f"/api/admin/campaigns/{cid2}/schedule", headers=H(at),
                      json={"scheduledAt": int(time.time() * 1000) + 60000})
    row = await db_session.get(Campaign, cid2)
    row.scheduled_at = 1  # backdate: became due while the server was down
    await db_session.commit()
    r = await client.post("/api/admin/campaigns/due-sweep", headers=H(at), json={})
    assert r.json()["sent"] >= 1, "due sweep sent the past-due campaign"
    r = await client.get(f"/api/admin/campaigns/{cid2}", headers=H(at))
    assert r.json()["campaign"]["status"] == "SENT"


async def test_push_through_engine(client, db_session):
    at = await admin_login(client)
    before = len((await db_session.execute(NotificationDelivery.__table__.select())).all())
    r = await client.post("/api/admin/push", headers=H(at), json={"message": "Temple timings changed"})
    assert r.status_code == 200, r.text
    assert r.json()["sent"] >= 1
    after = len((await db_session.execute(NotificationDelivery.__table__.select())).all())
    assert after > before, "push deliveries are recorded"


async def test_import_preview_commit_dedupe(client, db_session):
    await _mk_customer(db_session, "xi9", "Pre Existing", "9700000099", "xi9@t.in")
    await db_session.commit()
    at = await admin_login(client)
    buf = _xlsx([
        ["name", "mobile", "email", "source", "details"],
        ["New Import", "9700000010", "ni@t.in", "Partner", "met at expo"],
        ["Dup Name", "9700000010", "", "", ""],
        ["Pre Existing Renamed", "9700000099", "", "", ""],
        ["Bad Mobile", "12345", "", "", ""],
    ])
    files = {"file": ("t.xlsx", buf, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    r = await client.post("/api/admin/import/customers/preview", headers=H(at), files=files)
    assert r.status_code == 200, r.text
    pv = r.json()
    assert pv["total"] == 4
    assert pv["duplicatesInFile"] == 1
    assert len(pv["errors"]) == 2
    assert pv["willCreate"] == 1 and pv["willUpdate"] == 1

    # stateless preview: nothing written yet
    assert (await db_session.execute(
        User.__table__.select().where(User.mobile == "9700000010"))).scalars().all() == []

    r = await client.post("/api/admin/import/customers/commit", headers=H(at), files=files)
    assert r.status_code == 200, r.text
    assert r.json()["committed"] == 2
    fresh = (await db_session.execute(
        User.__table__.select().where(User.mobile == "9700000010"))).mappings().one()
    assert (await db_session.get(User, "xi9")).name == "Pre Existing Renamed"

    # re-import: everything is now an update
    r = await client.post("/api/admin/import/customers/preview", headers=H(at), files=files)
    assert r.json()["willCreate"] == 0
    assert r.json()["existing"] == 2

    # garbage file + unknown kind rejected
    r = await client.post("/api/admin/import/customers/preview", headers=H(at),
                          files={"file": ("t.xlsx", b"not a zip", "application/octet-stream")})
    assert r.status_code == 400
    r = await client.post("/api/admin/import/nope/preview", headers=H(at), files=files)
    assert r.status_code == 400

    # leads import rides the same engine
    buf2 = _xlsx([
        ["name", "mobile", "source", "details"],
        ["Lead One", "9700000020", "Partner", "met at expo"],
    ])
    r = await client.post("/api/admin/import/leads/commit", headers=H(at),
                          files={"file": ("l.xlsx", buf2, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert r.status_code == 200, r.text
    assert r.json()["committed"] == 1
    assert (await db_session.execute(
        Lead.__table__.select().where(Lead.mobile == "9700000020"))).scalars().all(), "lead captured"


async def test_comms_access_control(client, db_session):
    ct = await login(client, "customer")
    assert (await client.get("/api/admin/campaigns", headers=H(ct))).status_code == 403
    assert (await client.post("/api/admin/campaigns", headers=H(ct),
                              json={"name": "x", "channel": "Push", "audience": "All customers"})).status_code == 403
    assert (await client.get("/api/admin/campaigns")).status_code == 401
