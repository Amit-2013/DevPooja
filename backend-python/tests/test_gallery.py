"""Photo + Video Gallery (additional-requirements Phase D) — twin of
tests/gallery.test.js.

Albums, photos and YouTube videos are database rows, never hard-coded content:
the public gallery only ever sees active rows (un-albumed rows included; a
hidden album hides its members), photo uploads are magic-byte verified before
anything is written and keep their provenance, deleting an album never deletes
its media, and every admin write is audited.
"""
import io
import os
from pathlib import Path

import pytest
from PIL import Image

from tests.conftest import admin_login, login


def _h(token):
    return {"Authorization": "Bearer " + token}


def _png(color=(40, 120, 200), size=(80, 60)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_public_gallery_tabs_filter_and_pagination(client):
    r = await client.get("/api/gallery")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "photos"
    assert len(body["albums"]) == 3, "demo albums seeded"
    fest = next(a for a in body["albums"] if a["id"] == "gal-festival")
    assert fest["cover"].startswith("/media/"), "album cover comes from its first photo"
    assert fest["coverThumb"] and fest["coverThumbWebp"], "cover carries its variants"
    assert fest["photos"] >= 3, "album counts its photos"
    assert body["photos"] and body["total"] >= len(body["photos"])
    p0 = body["photos"][0]
    assert p0["url"].startswith("/media/gal-"), "demo photos are copies of the bundled, licensed images"
    assert p0["license"] and p0["credit"], "provenance rides along with the copy"
    assert p0["altText"], "alt text is stored per photo"

    # videos tab: the embed id and YouTube poster are derived from the URL
    v = (await client.get("/api/gallery", params={"kind": "videos"})).json()
    assert len(v["videos"]) >= 2, "demo videos seeded"
    assert v["videos"][0]["yt"]
    assert v["videos"][0]["thumb"].startswith("https://i.ytimg.com/vi/")

    # albums tab returns only the album cards
    a = (await client.get("/api/gallery", params={"kind": "albums"})).json()
    assert a["kind"] == "albums"
    assert "photos" not in a
    assert len(a["albums"]) == 3

    # album filter narrows the photos; unknown albums are refused
    f = (await client.get("/api/gallery", params={"album": "gal-festival"})).json()
    assert f["photos"]
    assert all(x["albumId"] == "gal-festival" for x in f["photos"])
    assert (await client.get("/api/gallery", params={"album": "nope"})).status_code == 400

    # pagination: pages never overlap
    pg = (await client.get("/api/gallery", params={"limit": 2})).json()
    assert len(pg["photos"]) == 2
    assert pg["nextOffset"] == 2, "nextOffset points at the next page"
    pg2 = (await client.get("/api/gallery", params={"limit": 2, "offset": pg["nextOffset"]})).json()
    assert all(x["id"] not in {y["id"] for y in pg["photos"]} for x in pg2["photos"])

    # /state carries the public overview for everyone, admin rows only for admins
    anon = (await client.get("/api/state")).json()
    assert len(anon["gallery"]["albums"]) == 3
    assert anon["gallery"]["photos"] and len(anon["gallery"]["videos"]) >= 2
    assert anon["gallery"]["totalPhotos"] >= len(anon["gallery"]["photos"])
    assert anon["galleryAdmin"] == {"albums": [], "photos": [], "videos": []}, \
        "anonymous state never carries admin rows"

    at = await admin_login(client)
    st = (await client.get("/api/state", headers=_h(at))).json()
    assert len(st["galleryAdmin"]["albums"]) == 3
    assert len(st["galleryAdmin"]["photos"]) >= 7
    assert len(st["galleryAdmin"]["videos"]) >= 2


@pytest.mark.asyncio
async def test_album_admin_crud_reorder_and_delete_keeps_media(client):
    at = await admin_login(client)
    ct = await login(client, "customer")
    assert (await client.get("/api/admin/gallery", headers=_h(ct))).status_code == 403
    assert (await client.get("/api/admin/gallery")).status_code in (401, 403)

    made = await client.post("/api/admin/gallery/albums",
                             json={"name": "Probe Album", "description": "Album for the probe"},
                             headers=_h(at))
    assert made.status_code == 201, made.text
    aid = made.json()["album"]["id"]
    assert aid.startswith("alb")
    assert made.json()["album"]["order"] == 4, "order defaults after the last album"
    assert made.json()["album"]["active"] == 1

    upd = await client.patch("/api/admin/gallery/albums/" + aid,
                             json={"name": "Renamed Album", "active": False}, headers=_h(at))
    assert upd.json()["album"]["n"] == "Renamed Album"
    assert upd.json()["album"]["active"] == 0
    public = (await client.get("/api/gallery", params={"kind": "albums"})).json()
    assert not any(x["id"] == aid for x in public["albums"]), "hidden albums never reach the public gallery"
    await client.patch("/api/admin/gallery/albums/" + aid, json={"active": True}, headers=_h(at))

    order = await client.post("/api/admin/gallery/albums/order", json={"ids": [aid, "gal-festival"]},
                              headers=_h(at))
    ids = [x["id"] for x in order.json()["albums"]]
    assert ids[0] == aid and ids[1] == "gal-festival"

    # deleting an album KEEPS its media: the photos become un-albumed and stay public
    before = (await client.get("/api/gallery", params={"album": "gal-behind"})).json()["photos"]
    assert before, "the demo album has photos to protect"
    dele = await client.request("DELETE", "/api/admin/gallery/albums/gal-behind",
                                json={"reason": "probe cleanup"}, headers=_h(at))
    assert dele.status_code == 200, dele.text
    assert dele.json()["photosKept"] >= 1, "the photos are reported as kept, not destroyed"
    orphans = (await client.get("/api/gallery", params={"kind": "photos", "limit": 48})).json()["photos"]
    assert any(p["albumId"] is None and p["id"] in {b["id"] for b in before} for p in orphans), \
        "the album's photos survive, un-albumed"

    from app.db import SessionLocal
    from app.models import AuditLog
    from sqlalchemy import select
    async with SessionLocal() as db:
        rows = (await db.execute(select(AuditLog).where(AuditLog.action == "gallery.album_delete",
                                                        AuditLog.entity_id == "gal-behind"))).scalars().all()
    assert rows and rows[-1].reason == "probe cleanup"

    missing = await client.request("DELETE", "/api/admin/gallery/albums/nope",
                                   json={"reason": "x"}, headers=_h(at))
    assert missing.status_code == 404
    gone = await client.request("DELETE", "/api/admin/gallery/albums/" + aid,
                                json={"reason": "probe cleanup"}, headers=_h(at))
    assert gone.status_code == 200


@pytest.mark.asyncio
async def test_photo_upload_variants_validation_visibility_and_delete(client):
    at = await admin_login(client)
    ct = await login(client, "customer")
    denied = await client.post("/api/admin/gallery/photos",
                               files={"photo": ("p.png", _png(), "image/png")}, headers=_h(ct))
    assert denied.status_code == 403

    up = await client.post("/api/admin/gallery/photos",
                           files={"photo": ("probe.png", _png(), "image/png")},
                           data={"caption": "Probe caption", "altText": "Probe alt text",
                                 "albumId": "gal-festival"},
                           headers=_h(at))
    assert up.status_code == 201, up.text
    photo = up.json()["photo"]
    assert photo["url"].startswith("/media/galp-")
    assert photo["thumb"] and photo["webp"] and photo["thumbWebp"], "thumb + WebP pair generated"
    assert photo["caption"] == "Probe caption"
    assert photo["albumId"] == "gal-festival"
    assert photo["active"] == 1

    # content that does not match its type never touches the disk
    fake = await client.post("/api/admin/gallery/photos",
                             files={"photo": ("evil.png", b"<html>not an image</html>", "image/png")},
                             headers=_h(at))
    assert fake.status_code == 400
    # a video file is not a gallery photo either
    clip = await client.post("/api/admin/gallery/photos",
                             files={"photo": ("clip.mp4", b"\x00\x00\x00\x18ftypmp42data", "video/mp4")},
                             headers=_h(at))
    assert clip.status_code == 400
    # a valid image but a made-up album is refused
    bad_album = await client.post("/api/admin/gallery/photos",
                                  files={"photo": ("p.png", _png((10, 90, 30)), "image/png")},
                                  data={"albumId": "nope"}, headers=_h(at))
    assert bad_album.status_code == 400

    # public reads: present while active, gone when hidden, back when restored
    pub = (await client.get("/api/gallery", params={"album": "gal-festival", "limit": 48})).json()
    assert any(p["id"] == photo["id"] for p in pub["photos"])
    await client.patch("/api/admin/gallery/photos/" + photo["id"],
                       json={"caption": "Renamed caption", "active": False}, headers=_h(at))
    pub = (await client.get("/api/gallery", params={"album": "gal-festival", "limit": 48})).json()
    assert not any(p["id"] == photo["id"] for p in pub["photos"])
    admin_rows = (await client.get("/api/admin/gallery", headers=_h(at))).json()["photos"]
    assert any(p["id"] == photo["id"] for p in admin_rows), "admins still see hidden rows"
    # un-album it (an empty albumId means "un-albumed") and restore
    await client.patch("/api/admin/gallery/photos/" + photo["id"],
                       json={"active": True, "albumId": ""}, headers=_h(at))
    pub = (await client.get("/api/gallery", params={"limit": 48})).json()["photos"]
    restored = next(p for p in pub if p["id"] == photo["id"])
    assert restored["caption"] == "Renamed caption"
    assert restored["albumId"] is None

    # the delete removes the stored artifacts and is audited with a reason
    stored = Path(os.environ["UPLOAD_DIR"]) / "media" / Path(photo["url"]).name
    assert stored.exists(), "the original was written to the media dir"
    dele = await client.request("DELETE", "/api/admin/gallery/photos/" + photo["id"],
                                json={"reason": "probe cleanup"}, headers=_h(at))
    assert dele.status_code == 200
    assert not stored.exists(), "the stored original is removed with the row"
    admin_rows = (await client.get("/api/admin/gallery", headers=_h(at))).json()["photos"]
    assert not any(p["id"] == photo["id"] for p in admin_rows)

    from app.db import SessionLocal
    from app.models import AuditLog
    from sqlalchemy import select
    async with SessionLocal() as db:
        actions = (await db.execute(select(AuditLog.action).where(AuditLog.entity_id == photo["id"]))).scalars().all()
        reason = (await db.execute(select(AuditLog.reason).where(
            AuditLog.action == "gallery.photo_delete", AuditLog.entity_id == photo["id"]))).scalars().first()
    assert "gallery.photo_add" in actions and "gallery.photo_delete" in actions
    assert reason == "probe cleanup"


@pytest.mark.asyncio
async def test_video_admin_url_validation_embed_and_audit(client):
    at = await admin_login(client)
    ct = await login(client, "customer")
    denied = await client.post("/api/admin/gallery/videos",
                               json={"title": "X", "url": "https://youtu.be/abc12345"}, headers=_h(ct))
    assert denied.status_code == 403

    assert (await client.post("/api/admin/gallery/videos",
                              json={"title": "Bad link", "url": "ftp://nope"},
                              headers=_h(at))).status_code == 400
    assert (await client.post("/api/admin/gallery/videos",
                              json={"title": "No link"}, headers=_h(at))).status_code == 400
    assert (await client.post("/api/admin/gallery/videos",
                              json={"url": "https://youtu.be/abc12345"},
                              headers=_h(at))).status_code == 400, "a title is required"

    made = await client.post("/api/admin/gallery/videos",
                             json={"title": "Probe video", "description": "Probe",
                                   "url": "https://www.youtube.com/watch?v=jTNu-R9KA-4",
                                   "albumId": "gal-festival"}, headers=_h(at))
    assert made.status_code == 201, made.text
    row = made.json()["video"]
    assert row["yt"] == "jTNu-R9KA-4", "the embed id is derived from the URL"
    assert row["thumb"].startswith("https://i.ytimg.com/vi/jTNu-R9KA-4/")
    assert row["active"] == 1
    pub = (await client.get("/api/gallery", params={"kind": "videos", "limit": 48})).json()
    assert any(v["id"] == row["id"] for v in pub["videos"])

    # hidden videos leave the public tab but stay manageable
    await client.patch("/api/admin/gallery/videos/" + row["id"], json={"active": False}, headers=_h(at))
    pub = (await client.get("/api/gallery", params={"kind": "videos", "limit": 48})).json()
    assert not any(v["id"] == row["id"] for v in pub["videos"])
    await client.patch("/api/admin/gallery/videos/" + row["id"],
                       json={"active": True, "title": "Renamed video"}, headers=_h(at))
    pub = (await client.get("/api/gallery", params={"kind": "videos", "limit": 48})).json()
    assert next(v for v in pub["videos"] if v["id"] == row["id"])["n"] == "Renamed video"

    order = await client.post("/api/admin/gallery/videos/order", json={"ids": [row["id"]]}, headers=_h(at))
    assert order.status_code == 200

    dele = await client.request("DELETE", "/api/admin/gallery/videos/" + row["id"],
                                json={"reason": "probe cleanup"}, headers=_h(at))
    assert dele.status_code == 200

    from app.db import SessionLocal
    from app.models import AuditLog
    from sqlalchemy import select
    async with SessionLocal() as db:
        rows = (await db.execute(select(AuditLog).where(AuditLog.entity_id == row["id"]))).scalars().all()
    actions = [r.action for r in rows]
    assert "gallery.video_create" in actions
    assert "gallery.video_update" in actions
    assert "gallery.video_delete" in actions
    deleted = next(r for r in rows if r.action == "gallery.video_delete")
    assert deleted.reason == "probe cleanup"
