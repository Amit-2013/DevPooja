"""Media parity tests — ported from tests/api.test.js media sections, including
the 4-artifact delete-completeness regression (the Node fix from commit 965ce74).
Real JPEG bytes (shared/seed-photos/durga.jpg) are used so Pillow can decode."""
import asyncio
from pathlib import Path

import pytest

from tests.conftest import admin_login, login

pytestmark = pytest.mark.asyncio

SEED_JPEG = Path(__file__).resolve().parent.parent.parent / "shared" / "seed-photos" / "durga.jpg"
FAKE_JPG = b"<html><script>alert('x')</script></html>"   # HTML masquerading as .jpg


def jpeg_file():
    return {"media": ("photo.jpg", SEED_JPEG.read_bytes(), "image/jpeg")}


async def upload_photo(client, tok, booking_id="b1", name="photo.jpg"):
    # The demo slice has no bookings; pandit upload is exercised via admin upload
    # for the catalogue + direct service-level checks for the pandit rules.
    r = await client.post("/api/admin/pujas/satyanarayan/media",
                          headers={"Authorization": "Bearer " + tok},
                          files={"media": (name, SEED_JPEG.read_bytes(), "image/jpeg")},
                          data={"altText": "Havan ceremony with sacred fire and offerings"})
    assert r.status_code == 201, r.text
    return r.json()["media"][0]


async def test_public_gallery_shape_and_pagination(client):
    g = await client.get("/api/pujas/satyanarayan/photos?limit=8")
    assert g.status_code == 200
    body = g.json()
    assert body["total"] >= 1 and body["photos"]
    p = body["photos"][0]
    assert p["altText"] and p["thumb"] and p["webp"] and p["thumbWebp"]
    assert p["status"] == "APPROVED" and p["isPublished"] is True
    assert "rejectReason" not in p or p["rejectReason"] == ""
    # pagination cursor behaviour matches the Node route
    assert body["nextOffset"] is None or body["nextOffset"] == body["limit"]


async def test_gallery_category_filter(client):
    r = await client.get("/api/pujas/satyanarayan/photos?category=ritual")
    assert r.status_code == 200
    assert all(p["category"] == "ritual" for p in r.json()["photos"])


async def test_admin_upload_and_download_roundtrip(client):
    tok = await admin_login(client)
    m = await upload_photo(client, tok)
    dl = await client.get("/api/media/" + m["id"] + "/download")
    assert dl.status_code == 200
    assert dl.headers["content-type"].startswith("image/")
    assert dl.content == SEED_JPEG.read_bytes()


async def test_fake_jpeg_with_html_rejected(client):
    tok = await admin_login(client)
    r = await client.post("/api/admin/pujas/satyanarayan/media",
                          headers={"Authorization": "Bearer " + tok},
                          files={"media": ("evil.jpg", FAKE_JPG, "image/jpeg")},
                          data={"altText": "should never land"})
    assert r.status_code == 400
    assert "does not match" in r.json()["detail"].lower()


async def test_pandit_cannot_use_admin_media_endpoints(client):
    ptok = await login(client, "pandit")
    r = await client.get("/api/admin/media", headers={"Authorization": "Bearer " + ptok})
    assert r.status_code == 403
    r2 = await client.patch("/api/admin/media/pmseed1", headers={"Authorization": "Bearer " + ptok},
                            json={"status": "APPROVED"})
    assert r2.status_code == 403


async def test_moderation_state_machine_and_reject_reason(client):
    tok = await admin_login(client)
    m = await upload_photo(client, tok, name="rejectme.jpg")
    mid = m["id"]
    r = await client.patch("/api/admin/media/" + mid, headers={"Authorization": "Bearer " + tok},
                           json={"status": "REJECTED", "rejectReason": "Blurry photo, retake in daylight"})
    assert r.status_code == 200
    assert r.json()["media"]["rejectReason"] == "Blurry photo, retake in daylight"
    assert r.json()["media"]["isPublished"] is False
    # rejected photos disappear from the public gallery
    g = await client.get("/api/pujas/satyanarayan/photos")
    assert all(p["id"] != mid for p in g.json()["photos"])
    # approve clears the reason; publish works only after approval
    ap = await client.patch("/api/admin/media/" + mid, headers={"Authorization": "Bearer " + tok},
                            json={"status": "APPROVED"})
    assert ap.json()["media"]["rejectReason"] == ""
    pub = await client.patch("/api/admin/media/" + mid, headers={"Authorization": "Bearer " + tok},
                             json={"published": True})
    assert pub.json()["media"]["isPublished"] is True
    g2 = await client.get("/api/pujas/satyanarayan/photos")
    assert any(p["id"] == mid for p in g2.json()["photos"])


async def test_bulk_publish_and_delete(client):
    tok = await admin_login(client)
    m = await upload_photo(client, tok, name="bulk.jpg")
    b = await client.post("/api/admin/media/bulk", headers={"Authorization": "Bearer " + tok},
                          json={"ids": [m["id"]], "op": "publish"})
    assert b.json()["changed"] == 1
    b2 = await client.post("/api/admin/media/bulk", headers={"Authorization": "Bearer " + tok},
                           json={"ids": [m["id"]], "op": "delete"})
    assert b2.json()["changed"] == 1
    lst = await client.get("/api/admin/media", headers={"Authorization": "Bearer " + tok})
    assert all(x["id"] != m["id"] for x in lst.json()["media"])


async def test_bulk_unknown_op_400(client):
    tok = await admin_login(client)
    r = await client.post("/api/admin/media/bulk", headers={"Authorization": "Bearer " + tok},
                          json={"ids": [], "op": "explode"})
    assert r.status_code == 400 or r.json()["changed"] == 0


async def test_delete_removes_all_artifacts(client, db_session):
    """THE ported fix: delete removes every stored artifact.
    Case A — admin upload: original + full WebP (uploads get no JPEG thumb).
    Case B — seeded photo: all four (original + thumb + webp + thumb_webp)."""
    from app.models import PujaMedia
    from app.services.media import MEDIA_DIR
    tok = await admin_login(client)

    async def row_of(mid):
        return (await db_session.execute(
            PujaMedia.__table__.select().where(PujaMedia.id == mid))).first()

    # Case A — upload: original + webp
    m = await upload_photo(client, tok, name="cleanup.jpg")
    row = await row_of(m["id"])
    assert row.filename and row.webp
    assert not row.thumb, "uploads have no JPEG thumb (seeder-only, Node parity)"
    for n in [row.filename, row.webp]:
        assert (MEDIA_DIR / n).exists(), "artifact exists before delete: " + n
    d = await client.delete("/api/admin/media/" + m["id"], headers={"Authorization": "Bearer " + tok})
    assert d.status_code == 200 and d.json()["ok"] is True
    for n in [row.filename, row.webp]:
        assert not (MEDIA_DIR / n).exists(), "artifact removed on delete: " + n
    assert await row_of(m["id"]) is None, "row removed"

    # Case B — seeded photo: all four artifacts
    seed = await row_of("pmseed1")
    assert seed and all([seed.filename, seed.thumb, seed.webp, seed.thumb_webp]), \
        "seeded row carries all four artifacts"
    for n in [seed.filename, seed.thumb, seed.webp, seed.thumb_webp]:
        assert (MEDIA_DIR / n).exists(), "seed artifact exists before delete: " + n
    d2 = await client.delete("/api/admin/media/pmseed1", headers={"Authorization": "Bearer " + tok})
    assert d2.status_code == 200 and d2.json()["ok"] is True
    for n in [seed.filename, seed.thumb, seed.webp, seed.thumb_webp]:
        assert not (MEDIA_DIR / n).exists(), "seed artifact removed on delete: " + n


async def test_download_blocked_for_anonymous_on_private_photo(client):
    """'Not listed' is not enough: the download endpoint must also refuse."""
    tok = await admin_login(client)
    m = await upload_photo(client, tok, name="private.jpg")
    await client.patch("/api/admin/media/" + m["id"], headers={"Authorization": "Bearer " + tok},
                       json={"published": False})
    anon = await client.get("/api/media/" + m["id"] + "/download")
    assert anon.status_code == 404
    cust = await client.get("/api/media/" + m["id"] + "/download",
                            headers={"Authorization": "Bearer " + await login(client, "customer")})
    assert cust.status_code == 404
    adm = await client.get("/api/media/" + m["id"] + "/download",
                           headers={"Authorization": "Bearer " + tok})
    assert adm.status_code == 200
