"""Our People CMS (additional-requirements Phase B) — twin of tests/people.test.js.

People and categories are database rows, never hard-coded pages: the nine
categories are reference data, the Founder and Main Acharya are ordinary rows
managed through the same admin CRUD, and every write is audited. Public reads
only ever return active people in active categories; photo uploads are
magic-byte verified before anything is written.
"""
import io

import pytest
from PIL import Image
from sqlalchemy import select

from tests.conftest import admin_login, login


def _h(token):
    return {"Authorization": "Bearer " + token}


def _png(color=(200, 40, 40), size=(60, 60)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


async def _create(client, token, **over):
    body = {"name": "Probe Person", "designation": "Acharya — Probe", "categoryId": "acharyas",
            "city": "Varanasi", "country": "India", "exp": 12, "quals": "Shastri",
            "expertise": ["Rudrabhishek", "Vastu"],
            "intro": "Probe intro", "bio": "Probe story", "background": "Probe background",
            "sanatanWork": "Probe seva", "order": 5}
    body.update(over)
    return await client.post("/api/admin/people", json=body, headers=_h(token))


@pytest.mark.asyncio
async def test_public_directory_lists_seeded_people_in_category_order(client):
    r = await client.get("/api/people")
    assert r.status_code == 200, r.text
    body = r.json()
    assert [c["id"] for c in body["categories"]] == [
        "founder", "main-acharya", "acharyas", "vedic-scholars", "jyotish-experts",
        "pandits", "temple-reps", "advisors", "team"]
    assert len(body["people"]) >= 18, "demo people seeded"
    assert all(p["n"] and p["categoryId"] for p in body["people"])
    seq = [p["categoryId"] for p in body["people"]]
    assert seq == sorted(seq, key=lambda cid: [c["id"] for c in body["categories"]].index(cid)), \
        "people grouped in the exact category order"
    assert not any(p.get("bio") for p in body["people"]), "listing is compact (no story payload)"

    founder = (await client.get("/api/people/perfounder")).json()["person"]
    assert founder["n"] == "Shri Devendra Shastri"
    assert founder["categoryId"] == "founder"
    assert len(founder["bio"]) > 200, "the Founder story is real content"
    assert founder["photos"] == []
    acharya = (await client.get("/api/people/peracharya")).json()["person"]
    assert acharya["designation"].startswith("Main Acharya")
    assert (await client.get("/api/people/nobody-here")).status_code == 404


@pytest.mark.asyncio
async def test_admin_crud_visibility_and_audit(client, db_session):
    at = await admin_login(client)
    # access: the CMS is admin-only on both sides
    ct = await login(client, "customer")
    assert (await client.get("/api/admin/people", headers=_h(ct))).status_code == 403
    assert (await client.post("/api/admin/people", json={"name": "X"}, headers=_h(ct))).status_code == 403
    assert (await client.post("/api/admin/people", json={"name": "X"})).status_code in (401, 403)

    created = await _create(client, at)
    assert created.status_code == 201, created.text
    p = created.json()["person"]
    assert p["id"].startswith("per") and p["active"] == 1
    assert p["categoryName"] == "Acharyas"

    public = (await client.get("/api/people")).json()["people"]
    assert any(x["id"] == p["id"] for x in public), "active person is public"

    # validation: bad category, bad video link, bad socials are rejected
    assert (await _create(client, at, categoryId="made-up")).status_code == 400
    assert (await _create(client, at, video="javascript:alert(1)")).status_code == 400
    bad = await _create(client, at, socials=[{"platform": "x", "url": "ftp://nope"}])
    assert bad.status_code == 201, "bad socials are dropped, not fatal"
    assert bad.json()["person"]["socials"] == []

    # update + ordering
    upd = await client.patch("/api/admin/people/" + p["id"], json={"order": 1, "designation": "Acharya — Updated"},
                             headers=_h(at))
    assert upd.status_code == 200, upd.text
    assert upd.json()["person"]["designation"] == "Acharya — Updated"

    # deactivate: hidden from the public list and the profile 404s
    off = await client.patch("/api/admin/people/" + p["id"], json={"active": False}, headers=_h(at))
    assert off.json()["person"]["active"] == 0
    assert not any(x["id"] == p["id"] for x in (await client.get("/api/people")).json()["people"])
    assert (await client.get("/api/people/" + p["id"])).status_code == 404
    assert any(x["id"] == p["id"] for x in (await client.get("/api/admin/people", headers=_h(at))).json()["people"]), \
        "admins still see inactive people"

    from app.db import SessionLocal
    from app.models import AuditLog
    async with SessionLocal() as db:
        actions = (await db.execute(select(AuditLog.action).where(AuditLog.entity_id == p["id"]))).scalars().all()
    assert "people.create" in actions and "people.update" in actions

    # delete requires no reference and is audited with a reason
    dele = await client.request("DELETE", "/api/admin/people/" + p["id"],
                                json={"reason": "test cleanup"}, headers=_h(at))
    assert dele.status_code == 200 and dele.json()["ok"] is True
    assert (await client.get("/api/people/" + p["id"])).status_code == 404
    assert not any(x["id"] == p["id"] for x in (await client.get("/api/admin/people", headers=_h(at))).json()["people"])


@pytest.mark.asyncio
async def test_categories_crud_order_and_delete_guard(client):
    at = await admin_login(client)
    cats = (await client.get("/api/admin/people-categories", headers=_h(at))).json()["categories"]
    assert len(cats) == 9

    made = await client.post("/api/admin/people-categories", json={"name": "Guest Teachers"}, headers=_h(at))
    assert made.status_code == 201, made.text
    cid = made.json()["category"]["id"]
    assert made.json()["category"]["order"] == 10

    renamed = await client.patch("/api/admin/people-categories/" + cid, json={"name": "Guest Acharyas", "order": 0},
                                 headers=_h(at))
    assert renamed.json()["category"] == {"id": cid, "n": "Guest Acharyas", "order": 0, "active": 1,
                                          "created": renamed.json()["category"]["created"]}

    order = await client.post("/api/admin/people-categories/order", json={"ids": [cid, "founder"]}, headers=_h(at))
    assert order.status_code == 200
    ids = [c["id"] for c in order.json()["categories"]]
    assert ids[0] == cid and ids[1] == "founder"

    # a category with people cannot be deleted; an empty one can
    used = await client.request("DELETE", "/api/admin/people-categories/acharyas",
                                json={"reason": "probe"}, headers=_h(at))
    assert used.status_code == 400
    empty = await client.request("DELETE", "/api/admin/people-categories/" + cid,
                                 json={"reason": "probe cleanup"}, headers=_h(at))
    assert empty.status_code == 200 and empty.json()["ok"] is True
    assert (await client.get("/api/admin/people-categories", headers=_h(at))).json()["categories"][0]["id"] == "founder"

    # a customer can never reach the category admin surface
    ct = await login(client, "customer")
    assert (await client.get("/api/admin/people-categories", headers=_h(ct))).status_code == 403


@pytest.mark.asyncio
async def test_photo_upload_variants_gallery_and_rejects(client):
    at = await admin_login(client)
    p = (await _create(client, at, name="Photo Probe")).json()["person"]

    up = await client.post("/api/admin/people/" + p["id"] + "/photo",
                           files={"photo": ("probe.png", _png(), "image/png")}, headers=_h(at))
    assert up.status_code == 200, up.text
    person = up.json()["person"]
    assert person["photo"].startswith("/media/people-")
    assert person["photoThumb"] and person["photoThumbWebp"], "variants generated"

    pub = (await client.get("/api/people/" + p["id"])).json()["person"]
    assert pub["photo"] == person["photo"]

    # content that does not match its type never touches the disk
    fake = await client.post("/api/admin/people/" + p["id"] + "/photo",
                             files={"photo": ("evil.png", b"<html>not an image</html>", "image/png")},
                             headers=_h(at))
    assert fake.status_code == 400

    gal = await client.post("/api/admin/people/" + p["id"] + "/photos",
                            files={"photo": ("g.png", _png((10, 80, 160)), "image/png")},
                            data={"caption": "Probe gallery"}, headers=_h(at))
    assert gal.status_code == 201, gal.text
    photo = gal.json()["photo"]
    assert photo["url"].startswith("/media/peoplep-") and photo["caption"] == "Probe gallery"
    assert (await client.get("/api/people/" + p["id"])).json()["person"]["photos"][0]["id"] == photo["id"]
    admin_row = next(x for x in (await client.get("/api/admin/people", headers=_h(at))).json()["people"]
                     if x["id"] == p["id"])
    assert admin_row["photos"][0]["id"] == photo["id"], \
        "admin payload carries the gallery (drives the Photos dialog)"

    gone = await client.request("DELETE", "/api/admin/people/photos/" + photo["id"],
                                json={"reason": "probe cleanup"}, headers=_h(at))
    assert gone.status_code == 200
    assert (await client.get("/api/people/" + p["id"])).json()["person"]["photos"] == []

    cleared = await client.request("DELETE", "/api/admin/people/" + p["id"] + "/photo",
                                   json={"reason": "probe cleanup"}, headers=_h(at))
    assert cleared.status_code == 200
    assert cleared.json()["person"]["photo"] == ""
    assert (await client.get("/api/people/" + p["id"])).json()["person"]["photo"] == ""
