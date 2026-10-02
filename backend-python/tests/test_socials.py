"""Social Media CMS (additional-requirements Phase C) — twin of
tests/socials.test.js. The footer's social icons are database rows, never
hard-coded markup: the demo seeder adds Facebook/Instagram/YouTube plus one
DISABLED international example, admins add/order/hide/delete through
/admin/social-links, and only the active rows ever reach the public /state
payload the footer renders.
"""
import pytest
from sqlalchemy import select

from tests.conftest import admin_login, login


def _h(token):
    return {"Authorization": "Bearer " + token}


@pytest.mark.asyncio
async def test_demo_footer_links_ride_state_in_order(client, db_session):
    anon = (await client.get("/api/state")).json()
    assert [s["platform"] for s in anon["socials"]] == ["facebook", "instagram", "youtube"], \
        "FB/IG/YT seeded active, in order"
    assert anon["socials"][0]["url"] == "https://www.facebook.com/daivikpooja"
    assert anon["socials"][0]["icon"] == "facebook", "icon key points into the built-in SVG set"
    assert all(s["active"] for s in anon["socials"]), "the footer never receives a hidden row"

    at = await admin_login(client)
    st = (await client.get("/api/state", headers=_h(at))).json()
    assert len(st["socialsAdmin"]) == 4, "admins see the disabled international example too"
    disabled = next(s for s in st["socialsAdmin"] if s["platform"] == "linkedin")
    assert disabled["active"] is False
    assert all(s["platform"] != "linkedin" for s in st["socials"])


@pytest.mark.asyncio
async def test_admin_crud_validation_order_and_audit(client, db_session):
    at = await admin_login(client)
    ct = await login(client, "customer")
    assert (await client.get("/api/admin/social-links", headers=_h(ct))).status_code == 403
    anon = await client.post("/api/admin/social-links",
                             json={"platform": "x", "url": "https://x.com/d"})
    assert anon.status_code in (401, 403)

    # a URL without a scheme is refused before anything is written
    bad = await client.post("/api/admin/social-links",
                            json={"platform": "whatsapp", "url": "whatsapp://chat"},
                            headers=_h(at))
    assert bad.status_code == 400

    made = await client.post("/api/admin/social-links",
                             json={"platform": "WhatsApp", "icon": "whatsapp",
                                   "url": "https://wa.me/919999999999"},
                             headers=_h(at))
    assert made.status_code == 201, made.text
    s = made.json()["link"]
    assert s["platform"] == "whatsapp", "platform normalised to a key"
    assert s["order"] == 5, "appends after the last row"
    assert s["active"] is True

    upd = await client.patch("/api/admin/social-links/" + s["id"],
                             json={"icon": "made-up-glyph", "order": 0, "active": False},
                             headers=_h(at))
    assert upd.status_code == 200
    assert upd.json()["link"]["icon"] == "made-up-glyph", \
        "unknown icon keys round-trip (the FE falls back to the globe)"
    assert upd.json()["link"]["active"] is False

    from app.db import SessionLocal
    from app.models import AuditLog
    async with SessionLocal() as db:
        row = (await db.execute(select(AuditLog).where(
            AuditLog.action == "social.update", AuditLog.entity_id == s["id"]))).scalars().first()
    assert row is not None, "update audited"
    assert row.old_value == '{"active": true}'
    assert row.new_value == '{"active": false}'

    # hide -> public state loses it, admin list keeps it; show round-trips
    assert all(x["id"] != s["id"] for x in (await client.get("/api/state")).json()["socials"])
    assert any(x["id"] == s["id"] for x in (await client.get("/api/state", headers=_h(at))).json()["socialsAdmin"])
    await client.patch("/api/admin/social-links/" + s["id"], json={"active": True}, headers=_h(at))
    assert any(x["id"] == s["id"] for x in (await client.get("/api/state")).json()["socials"])

    # reorder renumbers the footer from the given id list (real ids, or the row
    # keeps its position — the endpoint never guesses by name)
    links = (await client.get("/api/admin/social-links", headers=_h(at))).json()["links"]
    id_of = {x["platform"]: x["id"] for x in links}
    order = await client.post("/api/admin/social-links/order",
                              json={"ids": [s["id"], id_of["facebook"], id_of["instagram"],
                                            id_of["youtube"]]},
                              headers=_h(at))
    assert order.status_code == 200, order.text
    assert [x["id"] for x in order.json()["links"][:2]] == [s["id"], id_of["facebook"]]
    assert [x["platform"] for x in (await client.get("/api/state")).json()["socials"]] == \
        ["whatsapp", "facebook", "instagram", "youtube"]


@pytest.mark.asyncio
async def test_delete_is_audited_with_a_reason(client, db_session):
    at = await admin_login(client)
    # each test starts on a fresh database, so create the link we delete
    made = await client.post("/api/admin/social-links",
                             json={"platform": "whatsapp", "icon": "whatsapp",
                                   "url": "https://wa.me/919999999999"},
                             headers=_h(at))
    assert made.status_code == 201, made.text
    s = made.json()["link"]
    links = (await client.get("/api/admin/social-links", headers=_h(at))).json()["links"]
    assert any(x["id"] == s["id"] for x in links)

    dele = await client.request("DELETE", "/api/admin/social-links/" + s["id"],
                                json={"reason": "probe cleanup"}, headers=_h(at))
    assert dele.status_code == 200 and dele.json()["ok"] is True
    from app.db import SessionLocal
    from app.models import AuditLog
    async with SessionLocal() as db:
        row = (await db.execute(select(AuditLog).where(
            AuditLog.action == "social.delete", AuditLog.entity_id == s["id"]))).scalars().first()
    assert row is not None and row.reason == "probe cleanup"
    assert all(x["id"] != s["id"] for x in
               (await client.get("/api/admin/social-links", headers=_h(at))).json()["links"])
    again = await client.request("DELETE", "/api/admin/social-links/" + s["id"],
                                 json={"reason": "again"}, headers=_h(at))
    assert again.status_code == 404


@pytest.mark.asyncio
async def test_reorder_guard_and_edit_validation(client):
    at = await admin_login(client)
    empty = await client.post("/api/admin/social-links/order", json={"ids": []}, headers=_h(at))
    assert empty.status_code == 400
    fb = next(x for x in (await client.get("/api/admin/social-links", headers=_h(at))).json()["links"]
              if x["platform"] == "facebook")
    bad_url = await client.patch("/api/admin/social-links/" + fb["id"],
                                 json={"url": "javascript:alert(1)"}, headers=_h(at))
    assert bad_url.status_code == 400
    bad_platform = await client.patch("/api/admin/social-links/" + fb["id"],
                                      json={"platform": ""}, headers=_h(at))
    assert bad_platform.status_code == 400
    # the row is untouched after both rejections
    fb2 = next(x for x in (await client.get("/api/admin/social-links", headers=_h(at))).json()["links"]
               if x["id"] == fb["id"])
    assert fb2["url"] == "https://www.facebook.com/daivikpooja"
