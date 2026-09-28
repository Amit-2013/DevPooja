"""Phase 20 — Python twin of tests/incident.test.js: pandit incident reporting
against their own bookings, ownership + vocabulary + min-length validation,
magic-checked evidence uploads (images + video), admin triage states with
required notes, closed-is-terminal, audits with old->new, notifications."""
from pathlib import Path

import pytest
from sqlalchemy import select

from app.models import Notif, Pandit, User
from tests.conftest import admin_login, login

pytestmark = pytest.mark.asyncio

PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452") + b"\x00" * 24
MP4 = b"\x00\x00\x00\x20ftypisom" + b"\x00" * 24


def _booking_body(o=None):
    o = o or {}
    import time
    return {"pujaId": "satyanarayan", "mode": "home",
            "date": time.strftime("%Y-%m-%d", time.localtime(time.time() + 20 * 86400)),
            "slot": "10:00 AM",
            "addr": {"line": "12 Test Street", "city": "Delhi NCR", "pin": "110001"},
            "panditId": "p1", "sam": [], "pra": [], **o}


async def _paid_booking(client, tok, o=None):
    r = await client.post("/api/bookings", headers={"Authorization": "Bearer " + tok},
                          json=_booking_body(o))
    assert r.status_code == 201, r.text
    return r.json()["booking"]


async def _pandit_uid(db, pandit_id="p1"):
    return (await db.execute(select(Pandit.user_id).where(Pandit.id == pandit_id))).scalar_one()


async def _notifs(db, uid):
    return (await db.execute(select(Notif).where(Notif.user_id == uid).order_by(Notif.id))).scalars().all()


async def test_report_against_own_booking_links_customer_audits_and_notifies(client, db_session):
    ct = await login(client, "customer")
    pt = await login(client, "pandit")
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    b = await _paid_booking(client, ct)

    admin_uids = (await db_session.execute(select(User.id).where(User.role == "admin"))).scalars().all()
    before = len(await _notifs(db_session, admin_uids[0]))

    r = await client.post("/api/pandit/incidents", headers={"Authorization": "Bearer " + pt},
                          json={"bookingId": b["id"], "category": "SAFETY_CONCERN",
                                "description": "Stray dogs blocked the courtyard approach during setup."})
    assert r.status_code == 201, r.text
    inc = r.json()["incident"]
    assert inc["status"] == "OPEN"
    assert inc["bookingId"] == b["id"]
    assert inc["customerId"] == b["userId"], "customer linked from the booking"
    assert inc["evidence"] == []

    audits = (await client.get("/api/admin/audit?limit=300", headers=aa)).json()["entries"]
    a = next(x for x in audits if x["action"] == "incident.reported" and x["entityId"] == inc["id"])
    assert a["role"] == "pandit", "actor role derived from the users row"
    assert a["newValue"] == {"status": "OPEN", "category": "SAFETY_CONCERN"}
    assert len(await _notifs(db_session, admin_uids[0])) == before + 1, "admin notified in-app"

    mine = (await client.get("/api/pandit/me/incidents", headers={"Authorization": "Bearer " + pt})).json()
    assert any(x["id"] == inc["id"] for x in mine["incidents"])
    assert "SAMAGRI_ISSUE" in mine["categories"]


async def test_ownership_and_validation(client):
    ct = await login(client, "customer")
    pt = await login(client, "pandit")
    h = {"Authorization": "Bearer " + pt}
    own = await _paid_booking(client, ct)
    other = await _paid_booking(client, ct, {"panditId": "p2"})

    bad_own = await client.post("/api/pandit/incidents", headers=h,
                                json={"bookingId": other["id"], "category": "OTHER",
                                      "description": "This booking is assigned to another pandit."})
    assert bad_own.status_code == 400, "not your booking"
    nf = await client.post("/api/pandit/incidents", headers=h,
                           json={"bookingId": "DPNOPE99", "category": "OTHER",
                                 "description": "A booking that simply does not exist anywhere."})
    assert nf.status_code == 404
    bad_cat = await client.post("/api/pandit/incidents", headers=h,
                                json={"category": "MADE_UP", "description": "Category outside the fixed vocabulary."})
    assert bad_cat.status_code == 400
    short = await client.post("/api/pandit/incidents", headers=h,
                              json={"category": "OTHER", "description": "short"})
    assert short.status_code == 400, "min 10 characters"
    ok = await client.post("/api/pandit/incidents", headers=h,
                           json={"bookingId": own["id"], "category": "PAYMENT_ISSUE",
                                 "description": "Customer refused the balance payment on arrival."})
    assert ok.status_code == 201, ok.text


async def test_evidence_upload_and_filtering(client, db_session):
    from app.config import get_settings
    pt = await login(client, "pandit")
    h = {"Authorization": "Bearer " + pt}

    r = await client.post("/api/pandit/incident-evidence", headers=h,
                          files=[("evidence", ("one.png", PNG, "image/png")),
                                 ("evidence", ("clip.mp4", MP4, "video/mp4"))])
    assert r.status_code == 200, r.text
    urls = r.json()["urls"]
    assert len(urls) == 2
    assert all(u.startswith("/media/") for u in urls), "urls served from the media dir"
    assert ",".join(sorted(u.split(".")[-1] for u in urls)) == "mp4,png", \
        "extensions follow the sniffed real types"

    fake = await client.post("/api/pandit/incident-evidence", headers=h,
                             files=[("evidence", ("fake.png", b"definitely not an image", "image/png"))])
    assert fake.status_code == 400, "magic check refuses mismatched content"

    rep = await client.post("/api/pandit/incidents", headers=h,
                            json={"category": "CUSTOMER_CONDUCT",
                                  "description": "Abusive language during the sankalp; recordings attached here.",
                                  "evidence": urls + ["http://evil.example/payload.png", "/etc/passwd"]})
    assert rep.status_code == 201, rep.text
    assert sorted(rep.json()["incident"]["evidence"]) == sorted(urls), "foreign strings dropped"

    media_dir = Path(get_settings().upload_dir) / "media"
    assert len(list(media_dir.glob("*"))) >= 2, "files written under the upload dir"


async def test_triage_lifecycle_audits_and_pandit_notifications(client, db_session):
    ct = await login(client, "customer")
    pt = await login(client, "pandit")
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    b = await _paid_booking(client, ct)
    inc = (await client.post("/api/pandit/incidents", headers={"Authorization": "Bearer " + pt},
                             json={"bookingId": b["id"], "category": "SAMAGRI_ISSUE",
                                   "description": "Kit arrived without the havan samagri packet."})).json()["incident"]
    uid = await _pandit_uid(db_session)
    before = len(await _notifs(db_session, uid))

    view = (await client.get("/api/admin/incidents", headers=aa)).json()
    assert any(x["id"] == inc["id"] for x in view["incidents"])
    assert view["counts"]["OPEN"] >= 1, "counts served"
    assert "OTHER" in view["categories"]

    assert (await client.patch("/api/admin/incidents/" + inc["id"], headers=aa,
                               json={"status": "UNDER_REVIEW"})).status_code == 400, "notes required"
    assert (await client.patch("/api/admin/incidents/" + inc["id"], headers=aa,
                               json={"status": "RESOLVED"})).status_code == 400, "resolution required"
    assert (await client.patch("/api/admin/incidents/" + inc["id"], headers=aa,
                               json={"status": "DISMISSED"})).status_code == 400, "reason required"
    assert (await client.patch("/api/admin/incidents/" + inc["id"], headers=aa,
                               json={"status": "WEIRD"})).status_code == 400
    nf = await client.patch("/api/admin/incidents/INCNOPE1", headers=aa,
                            json={"status": "RESOLVED", "resolution": "x"})
    assert nf.status_code == 404

    ur = await client.patch("/api/admin/incidents/" + inc["id"], headers=aa,
                            json={"status": "UNDER_REVIEW",
                                  "notes": "Checking the samagri dispatch log with the vendor."})
    assert ur.status_code == 200, ur.text
    assert ur.json()["incident"]["status"] == "UNDER_REVIEW"
    assert ur.json()["incident"]["adminNotes"] == "Checking the samagri dispatch log with the vendor."

    closed = await client.patch("/api/admin/incidents/" + inc["id"], headers=aa,
                                json={"status": "RESOLVED", "resolution": "Replacement kit dispatched; vendor penalised."})
    assert closed.status_code == 200, closed.text
    assert closed.json()["incident"]["status"] == "RESOLVED"
    assert closed.json()["incident"]["resolvedAt"], "resolved_at stamped"

    again = await client.patch("/api/admin/incidents/" + inc["id"], headers=aa,
                               json={"status": "DISMISSED", "reason": "reopen attempt"})
    assert again.status_code == 409, "closed is terminal"

    audits = (await client.get("/api/admin/audit?limit=300", headers=aa)).json()["entries"]
    tri = [x for x in audits if x["action"] == "incident.triage" and x["entityId"] == inc["id"]]
    assert len(tri) == 2
    assert tri[1]["oldValue"] == {"status": "OPEN"}, "oldest first in the pair"
    assert tri[0]["oldValue"] == {"status": "UNDER_REVIEW"}
    assert tri[0]["role"] == "admin"

    notifs = (await _notifs(db_session, uid))[before:]
    assert len(notifs) == 2, "under-review + resolved notifications"
    assert "under review" in notifs[0].message
    assert "resolved: " in notifs[1].message


async def test_access_and_dismissal(client, db_session):
    ct = await login(client, "customer")
    pt = await login(client, "pandit")
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    cth = {"Authorization": "Bearer " + ct}
    pth = {"Authorization": "Bearer " + pt}
    assert (await client.get("/api/admin/incidents", headers=cth)).status_code == 403
    assert (await client.get("/api/admin/incidents", headers=pth)).status_code == 403
    assert (await client.patch("/api/admin/incidents/INCX1", headers=cth,
                               json={"status": "RESOLVED", "resolution": "nope"})).status_code == 403

    b = await _paid_booking(client, ct)
    inc = (await client.post("/api/pandit/incidents", headers=pth,
                             json={"bookingId": b["id"], "category": "OTHER",
                                   "description": "Left luggage at the venue, retrieved later."})).json()["incident"]
    mine = (await client.get("/api/pandit/me/incidents", headers=pth)).json()["incidents"]
    assert any(x["id"] == inc["id"] for x in mine)

    dismiss = await client.patch("/api/admin/incidents/" + inc["id"], headers=aa,
                                 json={"status": "DISMISSED",
                                       "reason": "Duplicate filing pattern; details already tracked."})
    assert dismiss.status_code == 200, dismiss.text
    assert dismiss.json()["incident"]["status"] == "DISMISSED"
    assert not dismiss.json()["incident"]["resolvedAt"], "resolved_at only for RESOLVED"

    only = (await client.get("/api/admin/incidents", headers=aa, params={"status": "DISMISSED"})).json()["incidents"]
    assert only and all(x["status"] == "DISMISSED" for x in only), "status filter works"
    uid = await _pandit_uid(db_session)
    assert any("not actionable" in n.message for n in await _notifs(db_session, uid)), "dismissal notified"
