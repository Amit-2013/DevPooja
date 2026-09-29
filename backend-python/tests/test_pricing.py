"""Phase 11 — Python twin of tests/pricing.test.js: per-mode puja pricing.

Explicit flat per-mode prices override the legacy formula (pf multiplier does
not apply), modes restrict bookable puja types, the Python admin surface gains
create/patch (Node parity) with puja.create/puja.update audits.
"""
import pytest

from tests.conftest import admin_login, day_plus, login

pytestmark = pytest.mark.asyncio


def _booking_body(o=None):
    o = o or {}
    return {"pujaId": "satyanarayan", "mode": "home", "date": day_plus(20), "slot": "10:00 AM",
            "addr": {"line": "12 Test Street", "city": "Delhi NCR", "pin": "110001"},
            "sam": [], "pra": [], **o}


async def _quote(client, mode, puja="satyanarayan", date=None):
    return await client.post("/api/quote",
                             json={"pujaId": puja, "mode": mode,
                                   "date": date or day_plus(20), "slot": "10:00 AM"})


async def test_pricing_engine_flat_override_and_parity():
    from app.pricing import quote
    assert quote("home", {"puja": {"price": 2500}})["svc"] == 2500
    assert quote("online", {"puja": {"price": 2500}, "modePrice": 1999})["svc"] == 1999
    assert quote("home", {"puja": {"price": 2500}, "pandit": {"pf": 1.5}, "modePrice": 1999})["svc"] == 1999
    assert quote("home", {"puja": {"price": 2500}, "pandit": {"pf": 1.5}})["svc"] == 3750
    assert quote("online", {"puja": {"price": 2500}, "modePrice": None})["svc"] == \
        quote("online", {"puja": {"price": 2500}})["svc"]


async def test_price_request_resolves_mode_price_and_gates_modes(client):
    ct = await login(client, "customer")
    aa = {"Authorization": "Bearer " + await admin_login(client)}

    p = await client.patch("/api/admin/pujas/satyanarayan", headers=aa,
                           json={"priceOnline": 1999, "modes": ["home", "online", "temple"]})
    assert p.status_code == 200, p.text

    q_online = (await _quote(client, "online")).json()["q"]
    assert q_online["svc"] == 1999, "explicit flat online price honoured"

    q_home = (await _quote(client, "home")).json()["q"]
    assert q_home["svc"] == 2500, "home still uses the legacy formula"

    refused = await _quote(client, "custom")
    assert refused.status_code == 400, refused.text
    assert "Customized Puja is not offered for this puja" in refused.json()["detail"]

    refused_booking = await client.post("/api/bookings", headers={"Authorization": "Bearer " + ct},
                                        json=_booking_body({"mode": "custom"}))
    assert refused_booking.status_code == 400
    ok = await client.post("/api/bookings", headers={"Authorization": "Bearer " + ct},
                           json=_booking_body({"mode": "online", "date": day_plus(21)}))
    assert ok.status_code == 201, ok.text
    assert ok.json()["booking"]["q"]["svc"] == 1999, "booking carries the flat per-mode price"

    cleared = await client.patch("/api/admin/pujas/satyanarayan", headers=aa,
                                 json={"priceOnline": None, "modes": ["home", "online", "temple", "custom"]})
    assert cleared.status_code == 200
    q_back = (await _quote(client, "online")).json()["q"]
    assert q_back["svc"] == 1750, "None restores the legacy online price"

    state = (await client.get("/api/state", headers={"Authorization": "Bearer " + ct})).json()
    sp = [x for x in state["catalog"]["pujas"] if x["id"] == "satyanarayan"][0]
    assert sp["priceOnline"] is None
    assert "home" in sp["modes"]


async def test_puja_admin_create_patch_audited(client):
    aa = {"Authorization": "Bearer " + await admin_login(client)}

    r = await client.post("/api/admin/pujas", headers=aa,
                          json={"name": "Saraswati Vandana", "hindi": "सरस्वती वंदना",
                                "cat": "Deity Worship", "dur": 60, "price": 1800,
                                "kit": "k_basic", "modes": ["home", "online"]})
    assert r.status_code == 201, r.text

    audits = (await client.get("/api/admin/audit?limit=300", headers=aa)).json()["entries"]
    assert any(a for a in audits if a["action"] == "puja.create"
               and a["detail"].get("name") == "Saraswati Vandana"), "puja.create audited"

    bad_modes = await client.patch("/api/admin/pujas/satyanarayan", headers=aa,
                                   json={"modes": ["telepathy"]})
    assert bad_modes.status_code == 400, "at least one valid mode required"
    bad_price = await client.patch("/api/admin/pujas/satyanarayan", headers=aa,
                                   json={"priceTemple": 10})
    assert bad_price.status_code == 400, "per-mode price bounds enforced"

    upd = await client.patch("/api/admin/pujas/satyanarayan", headers=aa,
                             json={"priceTemple": 2250})
    assert upd.status_code == 200, upd.text
    audits2 = (await client.get("/api/admin/audit?limit=300", headers=aa)).json()["entries"]
    assert any(a for a in audits2 if a["action"] == "puja.update"
               and a["entityId"] == "satyanarayan"), "puja.update audited"

    listing = (await client.get("/api/admin/pujas", headers=aa)).json()["pujas"]
    sp = [x for x in listing if x["id"] == "satyanarayan"][0]
    assert sp["priceTemple"] == 2250, "per-mode price persisted and served"
