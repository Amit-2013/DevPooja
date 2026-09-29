"""Phase 6 — Python twin of tests/mediagate.test.js: service photo date gate.

Pandit uploads are accepted only when booking.date == today (server-side,
overridable per booking by an admin; every override flip is audited as
media.date_gate_override with old→new). Every media row carries an upload_date
snapshot of the puja date for the admin attribution view. Parity with
server/services/pujaMedia.js / app/services/media.py.
"""
import io
import json
import time

import pytest
from sqlalchemy import select

from tests.conftest import admin_login, login

pytestmark = pytest.mark.asyncio

GATE = "Photos can only be uploaded on the scheduled puja date — ask the admin for an override"


def _day_plus(n: int) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(time.time() + n * 86400))


def _booking_body(o=None):
    o = o or {}
    return {"pujaId": "satyanarayan", "mode": "home", "date": _day_plus(20),
            "slot": "10:00 AM",
            "addr": {"line": "12 Test Street", "city": "Delhi NCR", "pin": "110001"},
            "panditId": "p1", "sam": [], "pra": [], **o}


def _png():
    return {"media": ("gate.png", io.BytesIO(bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000d49444154789c626001000000ffff03000006000557bfabd400000000"
        "49454e44ae426082")), "image/png")}


async def _upload(client, tok, booking_id, alt="Phase 6 gate test photo"):
    return await client.post("/api/pandit/media",
                             headers={"Authorization": "Bearer " + tok},
                             data={"bookingId": booking_id, "altText": alt},
                             files=_png())


async def _mk_booking(db, booking_id, date, status="Confirmed", override=0):
    """Direct-insert booking for p1 (the demo slice has no seeded bookings)."""
    from app.models import Booking
    db.add(Booking(id=booking_id, user_id="u1", puja_id="satyanarayan", mode="home",
                   date=date, slot="10:00 AM",
                   addr=json.dumps({"line": "1 Gate Street", "city": "Delhi NCR", "pin": "110001"}),
                   pandit_id="p1", pst="accepted", sam="[]", pra="[]", notes="", member="Self",
                   coupon="", q=json.dumps({"svc": 2000, "total": 2509}), status=status,
                   pay=json.dumps({"paid": True, "method": "UPI", "ref": "MOCKX1"}),
                   ops="{}", media="[]", media_override=override,
                   created=int(time.time() * 1000), log="[]"))
    await db.commit()


async def test_gate_allows_only_the_puja_date(client, db_session):
    tok = await login(client, "pandit")
    await _mk_booking(db_session, "DPGTODAY1", _day_plus(0))
    await _mk_booking(db_session, "DPGFUT1", _day_plus(7))
    await _mk_booking(db_session, "DPGPAST1", _day_plus(-30), status="Completed")

    ok = await _upload(client, tok, "DPGTODAY1")
    assert ok.status_code == 201, ok.text
    body = ok.json()
    assert body["media"][0]["uploadDate"] == _day_plus(0), "upload_date snapshot stamped"
    assert body["media"][0]["status"] == "PENDING_ADMIN_REVIEW"

    refused = await _upload(client, tok, "DPGFUT1")
    assert refused.status_code == 400, refused.text
    assert refused.json()["detail"] == GATE

    refused_past = await _upload(client, tok, "DPGPAST1")
    assert refused_past.status_code == 400
    assert refused_past.json()["detail"] == GATE


async def test_admin_override_opens_and_closes_the_gate_with_audit(client, db_session):
    atok = await admin_login(client)
    tok = await login(client, "pandit")
    await _mk_booking(db_session, "DPGOVR1", _day_plus(7))

    assert (await _upload(client, tok, "DPGOVR1")).status_code == 400

    r = await client.post("/api/admin/bookings/DPGOVR1/media-override",
                          headers={"Authorization": "Bearer " + atok}, json={"enable": True})
    assert r.status_code == 200, r.text
    assert r.json()["booking"]["mediaOverride"] is True

    ok = await _upload(client, tok, "DPGOVR1")
    assert ok.status_code == 201, ok.text
    assert ok.json()["media"][0]["uploadDate"] == _day_plus(7), "snapshot keeps the real puja date"

    entries = (await client.get("/api/admin/audit", headers={"Authorization": "Bearer " + atok})).json()["entries"]
    grant = [e for e in entries if e["action"] == "media.date_gate_override" and e["entityId"] == "DPGOVR1"
             and e["newValue"] and e["newValue"].get("mediaOverride") is True]
    assert grant, "override grant audited"
    assert grant[0]["oldValue"] == {"mediaOverride": False}
    assert grant[0]["role"] == "admin"
    up_audit = [e for e in entries if e["action"] == "media.pandit_upload"
                and e["detail"].get("bookingId") == "DPGOVR1"]
    assert up_audit and up_audit[0]["detail"].get("dateGate") == "admin_override"

    off = await client.post("/api/admin/bookings/DPGOVR1/media-override",
                            headers={"Authorization": "Bearer " + atok}, json={"enable": False})
    assert off.status_code == 200
    assert off.json()["booking"]["mediaOverride"] is False
    assert (await _upload(client, tok, "DPGOVR1")).status_code == 400

    entries2 = (await client.get("/api/admin/audit", headers={"Authorization": "Bearer " + atok})).json()["entries"]
    assert [e for e in entries2 if e["action"] == "media.date_gate_override"
            and e["entityId"] == "DPGOVR1" and e["newValue"] and e["newValue"].get("mediaOverride") is False], \
        "revocation audited"


async def test_ownership_role_and_admin_attribution(client, db_session):
    atok = await admin_login(client)
    ctok = await login(client, "customer")
    ptok = await login(client, "pandit")
    await _mk_booking(db_session, "DPGATTR1", _day_plus(7), override=1)

    r = await client.post("/api/admin/bookings/DPGATTR1/media-override",
                          headers={"Authorization": "Bearer " + atok}, json={"enable": True})
    assert r.status_code == 200
    assert (await _upload(client, ctok, "DPGATTR1")).status_code == 403, "customers never upload"
    assert (await _upload(client, ptok, "DPGNOPE1")).status_code == 404, "unknown booking 404s"

    ok = await _upload(client, ptok, "DPGATTR1", alt="Attribution check photo")
    assert ok.status_code == 201, ok.text
    m = ok.json()["media"][0]
    assert m["uploadedBy"], "uploadedBy recorded"
    assert m["createdAt"] > 0, "upload timestamp recorded"

    lst = (await client.get("/api/admin/media", params={"source": "pandit"},
                            headers={"Authorization": "Bearer " + atok})).json()["media"]
    row = [x for x in lst if x["id"] == m["id"]]
    assert row, "admin media list shows the upload"
    assert row[0]["uploadedBy"] and row[0]["createdAt"] and row[0]["uploadDate"] == _day_plus(7), \
        "timestamp + actor + puja date visible to admin"

    mine = (await client.get("/api/pandit/media", headers={"Authorization": "Bearer " + ptok})).json()["media"]
    assert [x for x in mine if x["id"] == m["id"] and x["uploadDate"] == _day_plus(7)]
