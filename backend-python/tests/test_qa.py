"""Phases 5 + 17 — Python twin of tests/qa.test.js: profile enrichment
(photo upload incl. /media serving), the QA & rating engine (overall = mean,
cached score, validation, delete recomputes, audit trail) and the derived
cancellation/no-show metrics."""
import io
import time

import pytest

pytestmark = pytest.mark.asyncio

JPEG = b"\xff\xd8\xff\xd9\x11\x22\x33\x44"


def _day_plus(n: int) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(time.time() + n * 86400))


async def _admin(client) -> str:
    r = await client.post("/api/auth/admin",
                          json={"email": "admin@daivikpuja.in", "password": "admin123"})
    return r.json()["token"]


async def _booking_for_p1(client, token: str, day: int) -> dict:
    """The Python demo seeder is a minimal slice with no mock bookings, so the
    derived-metrics assertions create a real booking via the API (the Node seeder
    already assigns mock bookings to pandits)."""
    r = await client.post("/api/bookings", headers={"Authorization": f"Bearer {token}"}, json={
        "pujaId": "satyanarayan", "mode": "home", "date": _day_plus(day), "slot": "10:00 AM",
        "addr": {"line": "1 T", "city": "Chennai", "pin": "600005"},
        "panditId": "p1", "sam": [], "pra": []})
    assert r.status_code in (200, 201), r.text
    return r.json()


async def test_profile_enrichment_photo_and_serializer(client):
    r = await client.post("/api/auth/demo", json={"role": "pandit"})
    pa = {"Authorization": "Bearer " + r.json()["token"]}

    patch = await client.patch("/api/pandit/profile", headers=pa, json={
        "city": "Varanasi", "exp": 12, "langs": "Hindi, Sanskrit", "bio": "Vedic scholar",
        "spec": "rudra,ganesh", "avail": True, "gotra": "Bharadwaj",
        "quals": "Shastri, Acharya", "veda": "Smarta"})
    assert patch.status_code == 200, patch.text

    up = await client.post("/api/pandit/profile/photo",
                           files={"photo": ("me.jpg", io.BytesIO(JPEG), "image/jpeg")},
                           headers=pa)
    assert up.status_code == 200, up.text
    photo = up.json()["photo"]
    assert photo.startswith("/media/prof-")

    served = await client.get(photo)
    assert served.status_code == 200, "photo is publicly served from /media"

    st = (await client.get("/api/state", headers=pa)).json()
    me = next(p for p in st["pandits"] if p["id"] == st["session"]["pid"])
    assert me["gotra"] == "Bharadwaj"
    assert me["quals"] == "Shastri, Acharya"
    assert me["veda"] == "Smarta"
    assert me["photo"] == photo
    assert me["qa"] is None


async def test_qa_engine_scoring_validation_delete_audit(client):
    aa = {"Authorization": "Bearer " + await _admin(client)}

    r1 = await client.post("/api/admin/qa", headers=aa, json={
        "panditId": "p1", "punctuality": 5, "ritualCompliance": 4, "documentation": 3,
        "notes": "Good puja"})
    assert r1.status_code == 201, r1.text
    assert r1.json()["overall"] == 4, "overall is the mean of scored dimensions"

    r2 = await client.post("/api/admin/qa", headers=aa, json={"panditId": "p1", "punctuality": 3})
    assert r2.json()["overall"] == 3

    # real booking assigned to p1 so the derived metrics have a denominator
    cr = await client.post("/api/auth/demo", json={"role": "customer"})
    await _booking_for_p1(client, cr.json()["token"], 95)

    view = (await client.get("/api/admin/pandits/p1/qa", headers=aa)).json()
    assert view["qaScore"] == 3.5, "cached score is the average across records"
    assert len(view["records"]) == 2
    assert view["derived"]["assigned"] >= 1

    assert (await client.post("/api/admin/qa", headers=aa,
                              json={"panditId": "p1", "punctuality": 11})).status_code == 400
    assert (await client.post("/api/admin/qa", headers=aa,
                              json={"panditId": "p1", "punctuality": 2.5})).status_code == 400
    assert (await client.post("/api/admin/qa", headers=aa,
                              json={"panditId": "p1"})).status_code == 400
    assert (await client.post("/api/admin/qa", headers=aa,
                              json={"panditId": "nope", "punctuality": 4})).status_code == 404

    # a booking assigned to a DIFFERENT pandit is refused (404 when unknown)
    other = next((b for b in (await client.get("/api/state", headers=aa)).json()["bookings"]
                  if b.get("panditId") and b["panditId"] != "p1"), None)
    if other:
        assert (await client.post("/api/admin/qa", headers=aa, json={
            "panditId": "p1", "bookingId": other["id"], "punctuality": 4})).status_code == 400

    # customers cannot read QA
    assert (await client.get("/api/admin/qa",
                             headers={"Authorization": "Bearer " + cr.json()["token"]})).status_code == 403

    # delete recomputes the cached score; the deletion reason is audited
    dele = await client.request("DELETE", f"/api/admin/qa/{r2.json()['id']}", headers=aa,
                                json={"reason": "Duplicate entry — recorded twice by mistake"})
    assert dele.status_code == 200
    view = (await client.get("/api/admin/pandits/p1/qa", headers=aa)).json()
    assert view["qaScore"] == 4
    assert len(view["records"]) == 1

    audits = (await client.get("/api/admin/audit?limit=300", headers=aa)).json()["entries"]
    acts = {a["action"] for a in audits}
    assert "qa.recorded" in acts and "qa.deleted" in acts
    assert any(a["action"] == "qa.deleted" and "Duplicate entry" in (a["reason"] or "") for a in audits), \
        "the delete reason reaches the audit trail"

    # pandit self-view: own records + derived metrics
    pr = await client.post("/api/auth/demo", json={"role": "pandit"})
    mine = (await client.get("/api/pandit/me/qa",
                             headers={"Authorization": "Bearer " + pr.json()["token"]})).json()
    assert len(mine["records"]) >= 1
    assert mine["derived"]["assigned"] >= 1
    assert isinstance(mine["derived"]["noShowPct"], int)
