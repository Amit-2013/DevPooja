"""NRI accounts + profile location (additional-requirements Phase A) — twin of
tests/accounts.test.js. The account type is asked at registration and stored on
the SAME users row (never a second account, never a parallel auth path);
location is optional, validated, editable and only the fields the app needs are
stored. Switching the account type preserves every booking, address and family
datum on the account."""
import pytest
from sqlalchemy import select

from tests.conftest import admin_login, day_plus


async def _signup(client, email, account_type="normal", password="secret123"):
    return await client.post("/api/auth/email", json={"email": email, "password": password,
                                                      "name": "Phase A Probe",
                                                      "accountType": account_type})


def _booking_body():
    return {"pujaId": "satyanarayan", "mode": "home", "date": day_plus(21),
            "slot": "10:00 AM",
            "addr": {"line": "12 Test Street", "city": "Delhi NCR", "pin": "110001"},
            "panditId": "p1", "sam": [], "pra": []}


def _h(token):
    return {"Authorization": "Bearer " + token}


@pytest.mark.asyncio
async def test_registration_account_type_and_no_duplicates(client):
    r1 = await _signup(client, "phasea.nri@example.com", "nri")
    assert r1.status_code == 200, r1.text
    assert r1.json()["created"] is True, "first signup flagged as created"
    token = r1.json()["token"]
    st = (await client.get("/api/state", headers=_h(token))).json()
    assert st["me"]["accountType"] == "nri"
    assert st["me"]["location"] == {}
    uid = st["me"]["id"]

    dup = await client.post("/api/auth/email", json={"email": "phasea.nri@example.com",
                                                     "password": "wrongpass1"})
    assert dup.status_code == 401, "duplicate email with a wrong password is refused"

    r2 = await _signup(client, "phasea.nri@example.com", "normal")
    assert r2.json()["created"] is False, "existing email logs in"
    st2 = (await client.get("/api/state", headers=_h(r2.json()["token"]))).json()
    assert st2["me"]["id"] == uid, "same account id"
    assert st2["me"]["accountType"] == "nri", "login never rewrites the type"

    bad = await client.post("/api/auth/email", json={"email": "phasea.bad@example.com",
                                                     "password": "secret123", "name": "X",
                                                     "accountType": "vip"})
    assert bad.status_code == 400, "invalid account type rejected"


@pytest.mark.asyncio
async def test_otp_registration_carries_account_type(client):
    mobile = "9812300471"
    await client.post("/api/auth/otp/send", json={"mobile": mobile})
    v = await client.post("/api/auth/otp/verify", json={"mobile": mobile, "otp": "123456",
                                                        "name": "NRI OTP Probe",
                                                        "accountType": "nri"})
    assert v.status_code == 200, v.text
    assert v.json()["created"] is True
    st = (await client.get("/api/state", headers=_h(v.json()["token"]))).json()
    assert st["me"]["accountType"] == "nri"

    await client.post("/api/auth/otp/send", json={"mobile": mobile})
    v2 = await client.post("/api/auth/otp/verify", json={"mobile": mobile, "otp": "123456"})
    assert v2.json()["created"] is False, "second verify is a login"
    st2 = (await client.get("/api/state", headers=_h(v2.json()["token"]))).json()
    assert st2["me"]["id"] == st["me"]["id"], "same account"


@pytest.mark.asyncio
async def test_account_type_switch_preserves_data_and_audits(client):
    r = await _signup(client, "phasea.switch@example.com", "normal")
    token = r.json()["token"]
    h = _h(token)
    b = (await client.post("/api/bookings", json=_booking_body(), headers=h)).json()["booking"]
    fam = await client.post("/api/me/family", json={"relationship": "Mother",
                                                    "name": "Probe Mother"}, headers=h)
    assert fam.status_code == 201, fam.text
    addr = await client.post("/api/me/addresses", json={"l": "Home", "line": "5 Probe Lane",
                                                        "city": "Delhi NCR", "pin": "110001"},
                             headers=h)
    assert addr.status_code == 200, addr.text

    sw = await client.patch("/api/me", json={"accountType": "nri"}, headers=h)
    assert sw.status_code == 200, sw.text
    assert sw.json()["accountType"] == "nri"
    st = (await client.get("/api/state", headers=h)).json()
    assert st["me"]["accountType"] == "nri"
    assert any(x["id"] == b["id"] for x in st["bookings"]), "booking preserved"
    fam_list = (await client.get("/api/me/family", headers=h)).json()["family"]
    assert len(fam_list) == 1, "family member preserved"
    assert len(st["me"]["addr"]) == 1, "address preserved"

    from app.db import SessionLocal
    from app.models import AuditLog
    async with SessionLocal() as db:
        row = (await db.execute(select(AuditLog).where(
            AuditLog.action == "user.account_type_switch",
            AuditLog.entity_id == st["me"]["id"]))).scalars().first()
    assert row is not None, "switch audited"
    assert row.old_value == '"normal"'
    assert row.new_value == '"nri"'

    at = await admin_login(client)
    admin_state = (await client.get("/api/state", headers=_h(at))).json()
    assert next(u for u in admin_state["users"] if u["id"] == st["me"]["id"])["accountType"] == "nri"

    back = await client.patch("/api/me", json={"accountType": "normal"}, headers=h)
    assert back.json()["accountType"] == "normal"
    bad = await client.patch("/api/me", json={"accountType": "vip"}, headers=h)
    assert bad.status_code == 400


@pytest.mark.asyncio
async def test_location_capture_validation_audit_and_clear(client, db_session):
    r = await _signup(client, "phasea.loc@example.com", "normal")
    h = _h(r.json()["token"])
    auto = await client.patch("/api/me", json={"location": {
        "city": "London", "country": "United Kingdom", "lat": 51.5074, "lon": -0.1278,
        "source": "auto", "consentAt": 1760000000000}}, headers=h)
    assert auto.status_code == 200, auto.text
    assert auto.json()["location"]["source"] == "auto"
    st = (await client.get("/api/state", headers=h)).json()
    assert st["me"]["location"]["city"] == "London"
    assert st["me"]["location"]["lat"] == 51.5074
    assert st["me"]["location"]["consentAt"] > 0

    man = await client.patch("/api/me", json={"location": {
        "city": "Dubai", "country": "UAE", "source": "manual"}}, headers=h)
    assert man.json()["location"]["lat"] is None
    st = (await client.get("/api/state", headers=h)).json()
    assert st["me"]["location"]["city"] == "Dubai"
    assert st["me"]["location"]["source"] == "manual"

    from app.db import SessionLocal
    from app.models import AuditLog
    async with SessionLocal() as db:
        rows = (await db.execute(select(AuditLog).where(
            AuditLog.action == "user.location_update",
            AuditLog.entity_id == st["me"]["id"]))).scalars().all()
    assert rows, "location updates audited"

    bad_lat = await client.patch("/api/me", json={"location": {"city": "X", "lat": 999,
                                                               "lon": 0, "source": "auto"}}, headers=h)
    assert bad_lat.status_code == 400
    bad_src = await client.patch("/api/me", json={"location": {"city": "X", "source": "gps"}}, headers=h)
    assert bad_src.status_code == 400

    await client.patch("/api/me", json={"location": {}}, headers=h)
    st = (await client.get("/api/state", headers=h)).json()
    assert st["me"]["location"] == {}

    anon = await client.patch("/api/me", json={"accountType": "nri"})
    assert anon.status_code == 401, "customer-self only"


async def test_notification_prefs_and_notifs_centre(client):
    """Notification preferences (mute one channel or all, merged never
    clobbered) + the notifications centre (unread count in state, mark-as-read
    on view, ids form, 401 anonymous) — twin of the two new tests in
    tests/accounts.test.js."""
    import time

    from app.db import SessionLocal
    from app.models import Notif
    from tests.conftest import otp_login

    tok = await otp_login(client, "9811100772", "Mute Probe")
    h = {"Authorization": f"Bearer {tok}"}

    # channel mute round-trips
    r = await client.patch("/api/me", headers=h, json={
        "pref": {"deity": "", "lang": "English", "wa": True, "sms": True,
                 "em": False, "mute": ["WhatsApp", "Push"]}})
    assert r.status_code == 200, r.text
    st = (await client.get("/api/state", headers=h)).json()
    assert st["me"]["pref"]["mute"] == ["WhatsApp", "Push"], "channel mute round-trips"

    # mute-all round-trips
    await client.patch("/api/me", headers=h, json={
        "pref": {"deity": "", "lang": "English", "wa": True, "sms": True,
                 "em": True, "mute": "all"}})
    st = (await client.get("/api/state", headers=h)).json()
    assert st["me"]["pref"]["mute"] == "all", "mute-all round-trips"

    # a location-only PATCH must NOT wipe the mute list or the consent flags
    r = await client.patch("/api/me", headers=h, json={"location": {}})
    assert r.status_code == 200, r.text
    st = (await client.get("/api/state", headers=h)).json()
    assert st["me"]["pref"]["mute"] == "all", "mute survives a location-only save"
    assert st["me"]["pref"]["wa"] is True, "consent survives a location-only save"

    # unknown mute channels are normalised away
    await client.patch("/api/me", headers=h, json={
        "pref": {"deity": "", "lang": "English", "wa": False, "sms": False,
                 "em": False, "mute": ["Telepathy"]}})
    st = (await client.get("/api/state", headers=h)).json()
    assert st["me"]["pref"]["mute"] == [], "unknown mute channels dropped"

    # --- notifications centre ---
    uid = st["me"]["id"]
    now = int(time.time() * 1000)
    async with SessionLocal() as db:
        db.add(Notif(user_id=uid, channel="In-App", message="Bell probe one", ts=now))
        db.add(Notif(user_id=uid, channel="In-App", message="Bell probe two", ts=now))
        await db.commit()
    st = (await client.get("/api/state", headers=h)).json()
    assert st["notifsUnread"] == 2, "state carries the unread count for the bell badge"
    assert any(n["r"] is False for n in st["notifs"]), "unread rows expose the read flag"

    # mark-as-read on view: opening the panel clears the badge
    rr = await client.post("/api/me/notifs/read", headers=h, json={})
    assert rr.status_code == 200 and rr.json()["unread"] == 0, rr.text
    st = (await client.get("/api/state", headers=h)).json()
    assert st["notifsUnread"] == 0, "badge clears after the panel view"
    assert all(n["r"] is True for n in st["notifs"]), "rows marked read"

    # anonymous cannot mark anything read
    assert (await client.post("/api/me/notifs/read", json={})).status_code == 401

    # ids form: mark only the listed rows
    async with SessionLocal() as db:
        db.add(Notif(user_id=uid, channel="In-App", message="Third",
                     ts=int(time.time() * 1000)))
        await db.commit()
    st = (await client.get("/api/state", headers=h)).json()
    nid = next(n["id"] for n in st["notifs"] if not n["r"])
    rr = await client.post("/api/me/notifs/read", headers=h, json={"ids": [nid]})
    assert rr.json()["unread"] == 0, "ids form marks just the listed row"
