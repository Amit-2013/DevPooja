"""Booking parity tests — port of the Node blocks: 'server quote matches shared
pricing', 'booking: validation, success, double-booking protection, privacy',
'cancel gives tiered refund...', 'reschedule respects pandit availability',
'pandit flow: accept, start, complete', and cross-role security."""
import pytest

from app.pricing import quote as p_quote, refund_pct
from tests.conftest import admin_login, login, otp_login

pytestmark = pytest.mark.asyncio


def booking_body(o=None):
    d = {"pujaId": "satyanarayan", "mode": "home", "date": otp_login.day_plus(20),
         "slot": "10:00 AM",
         "addr": {"line": "12 Test Street", "city": "Delhi NCR", "pin": "110001"},
         "panditId": "p1", "sam": [], "pra": []}
    d.update(o or {})
    return d


async def test_server_quote_matches_shared_pricing_and_validates_coupons(client):
    tok = await login(client, "customer")
    st = (await client.get("/api/state", headers={"Authorization": "Bearer " + tok})).json()
    puja = next(p for p in st["catalog"]["pujas"] if p["id"] == "lakshmi")
    kit = next(k for k in st["catalog"]["kits"] if k["id"] == "k_lakshmi")
    r = await client.post("/api/quote", headers={"Authorization": "Bearer " + tok},
                          json={"pujaId": "lakshmi", "mode": "home", "panditId": "p1",
                                "sam": ["k_lakshmi"], "pra": [], "coupon": "DAIVIKPOOJA10"})
    expected = p_quote("home", {"puja": {"price": puja["price"]}, "pandit": {"pf": 1.15},
                                "plus": False, "kits": [{"price": kit["p"]}], "prasad": [],
                                "coupon": {"active": True, "type": "pct", "val": 10,
                                           "max": 500, "min": 1500}, "points": 0})
    assert r.status_code == 200
    assert r.json()["q"]["total"] == expected["total"]
    badq = await client.post("/api/quote", headers={"Authorization": "Bearer " + tok},
                             json={"pujaId": "lakshmi", "mode": "home", "coupon": "NOPE"})
    assert badq.json()["couponError"]


async def test_booking_validation_success_double_booking_privacy(client):
    t1 = await login(client, "customer")
    assert (await client.post("/api/bookings", headers={"Authorization": "Bearer " + t1},
                              json=booking_body({"date": otp_login.day_plus(0)}))).status_code == 400
    assert (await client.post("/api/bookings", headers={"Authorization": "Bearer " + t1},
                              json=booking_body({"pujaId": "nope"}))).status_code == 404
    assert (await client.post("/api/bookings", headers={"Authorization": "Bearer " + t1},
                              json=booking_body({"pujaId": "vivah", "mode": "temple"}))).status_code == 400
    assert (await client.post("/api/bookings", json=booking_body())).status_code == 401
    ok = await client.post("/api/bookings", headers={"Authorization": "Bearer " + t1},
                           json=booking_body())
    assert ok.status_code == 201
    assert ok.json()["booking"]["status"] == "Confirmed"
    assert ok.json()["booking"]["pst"] == "pending"
    t2 = await otp_login(client, "9000022222", "Second")
    clash = await client.post("/api/bookings", headers={"Authorization": "Bearer " + t2},
                              json=booking_body())
    assert clash.status_code == 409
    st = (await client.get("/api/state", headers={"Authorization": "Bearer " + t2})).json()
    assert st["bookings"] == []
    assert any(b["id"] == ok.json()["booking"]["id"] and b["p"] == "p1" for b in st["busy"])
    assert "userId" not in st["busy"][0]
    auto = await client.post("/api/bookings", headers={"Authorization": "Bearer " + t2},
                             json=booking_body({"panditId": ""}))
    assert auto.status_code == 201
    assert auto.json()["booking"]["panditId"]
    assert auto.json()["booking"]["panditId"] != "p1", "p1 is already booked in that slot"


async def test_cancel_tiered_refund_frees_slot_owner_only(client):
    t1 = await login(client, "customer")
    b = (await client.post("/api/bookings", headers={"Authorization": "Bearer " + t1},
                           json=booking_body({"date": otp_login.day_plus(30), "slot": "02:00 PM",
                                              "sam": ["k_satya"]}))).json()["booking"]
    t3 = await otp_login(client, "9000033333")
    assert (await client.post(f"/api/bookings/{b['id']}/cancel",
                              headers={"Authorization": "Bearer " + t3})).status_code == 404
    c = await client.post(f"/api/bookings/{b['id']}/cancel",
                          headers={"Authorization": "Bearer " + t1})
    assert c.status_code == 200
    assert c.json()["booking"]["status"] == "Cancelled"
    assert c.json()["booking"]["refund"]["pct"] == 100
    assert c.json()["booking"]["refund"]["amt"] == b["q"]["total"]
    assert (await client.post(f"/api/bookings/{b['id']}/cancel",
                              headers={"Authorization": "Bearer " + t1})).status_code == 400
    assert (await client.post("/api/bookings", headers={"Authorization": "Bearer " + t3},
                              json=booking_body({"date": otp_login.day_plus(30),
                                                "slot": "02:00 PM"}))).status_code == 201


async def test_reschedule_respects_pandit_availability(client):
    t1 = await login(client, "customer")
    b = (await client.post("/api/bookings", headers={"Authorization": "Bearer " + t1},
                           json=booking_body({"date": otp_login.day_plus(40),
                                              "slot": "08:00 AM"}))).json()["booking"]
    r = await client.post(f"/api/bookings/{b['id']}/reschedule",
                          headers={"Authorization": "Bearer " + t1},
                          json={"date": otp_login.day_plus(41), "slot": "08:00 AM"})
    assert r.status_code == 200
    assert r.json()["booking"]["date"] == otp_login.day_plus(41)
    assert (await client.post(f"/api/bookings/{b['id']}/reschedule",
                              headers={"Authorization": "Bearer " + t1},
                              json={"date": otp_login.day_plus(-1),
                                    "slot": "08:00 AM"})).status_code == 400


async def test_pandit_flow_accept_start_complete_review(client):
    tc = await login(client, "customer")
    tp = await login(client, "pandit")
    b = (await client.post("/api/bookings", headers={"Authorization": "Bearer " + tc},
                           json=booking_body({"date": otp_login.day_plus(50), "slot": "06:00 PM",
                                              "pujaId": "lakshmi"}))).json()["booking"]
    assert (await client.post(f"/api/pandit/bookings/{b['id']}/start",
                              headers={"Authorization": "Bearer " + tp})).status_code == 400
    a = await client.post(f"/api/pandit/bookings/{b['id']}/accept",
                          headers={"Authorization": "Bearer " + tp})
    assert a.json()["booking"]["status"] == "Assigned"
    s = await client.post(f"/api/pandit/bookings/{b['id']}/start",
                          headers={"Authorization": "Bearer " + tp})
    assert s.json()["booking"]["status"] == "Started"
    jpeg = b"\xff\xd8\xff" + b"\x00" * 32
    done = await client.post(f"/api/pandit/bookings/{b['id']}/complete",
                             headers={"Authorization": "Bearer " + tp},
                             files={"media": ("p.jpg", jpeg, "image/jpeg")})
    assert done.status_code == 200
    assert done.json()["booking"]["status"] == "Completed"
    assert done.json()["booking"]["media"] == 1
    st = (await client.get("/api/state", headers={"Authorization": "Bearer " + tp})).json()
    po = next((p for p in st["payouts"] if p["b"] == b["id"]), None)
    assert po and po["st"] == "PENDING", "canonical payout statuses (migration 012)"
    assert po["comm"] > 0 and po["gross"] == po["amt"] + po["comm"], "stored commission breakdown"
    assert all("XXXXXX" in (u["m"] or "") for u in st["users"]), "mobiles masked for pandits"
    rv = await client.post(f"/api/bookings/{b['id']}/review",
                           headers={"Authorization": "Bearer " + tc},
                           json={"r": 5, "t": "Wonderful"})
    assert rv.status_code == 200
    assert (await client.post(f"/api/bookings/{b['id']}/review",
                              headers={"Authorization": "Bearer " + tc},
                              json={"r": 5})).status_code == 409


async def test_cross_role_security(client):
    tc = await login(client, "customer")
    b = (await client.post("/api/bookings", headers={"Authorization": "Bearer " + tc},
                           json=booking_body({"date": otp_login.day_plus(60), "slot": "12:00 PM",
                                              "panditId": "p3"}))).json()["booking"]
    tp = await login(client, "pandit")
    assert (await client.post(f"/api/pandit/bookings/{b['id']}/accept",
                              headers={"Authorization": "Bearer " + tp})).status_code == 404
    assert (await client.post("/api/admin/settings", headers={"Authorization": "Bearer " + tc},
                              json={"commission": 1})).status_code == 403
    assert (await client.post(f"/api/pandit/bookings/{b['id']}/accept",
                              headers={"Authorization": "Bearer " + tc})).status_code == 403


async def test_admin_assign_cancel_refund_coupons_settings(client):
    ta = await admin_login(client)
    tc = await login(client, "customer")
    b = (await client.post("/api/bookings", headers={"Authorization": "Bearer " + tc},
                           json=booking_body({"date": otp_login.day_plus(70), "slot": "04:00 PM",
                                              "panditId": ""}))).json()["booking"]
    a = await client.post(f"/api/admin/bookings/{b['id']}/assign",
                          headers={"Authorization": "Bearer " + ta}, json={"panditId": "p4"})
    assert a.status_code == 200
    assert a.json()["booking"]["panditId"] == "p4"
    c = await client.post(f"/api/admin/bookings/{b['id']}/status",
                          headers={"Authorization": "Bearer " + ta}, json={"status": "Cancelled"})
    assert c.json()["booking"]["refund"]["state"] == "Initiated"
    rf = await client.post(f"/api/admin/bookings/{b['id']}/refund",
                           headers={"Authorization": "Bearer " + ta})
    assert rf.json()["booking"]["refund"]["state"] == "Processed"
    assert (await client.post("/api/admin/coupons", headers={"Authorization": "Bearer " + ta},
                              json={"code": "diwali5", "type": "flat", "val": 50,
                                    "min": 500})).status_code == 201
    assert (await client.post("/api/admin/coupons", headers={"Authorization": "Bearer " + ta},
                              json={"code": "DIWALI5", "type": "flat", "val": 50})).status_code == 409
    assert (await client.post("/api/admin/settings", headers={"Authorization": "Bearer " + ta},
                              json={"commission": 25})).status_code == 200
    st = (await client.get("/api/state", headers={"Authorization": "Bearer " + ta})).json()
    assert st["set"]["comm"] == 25
    assert any(x["code"] == "DIWALI5" for x in st["coupons"])


async def test_refund_tiers():
    assert refund_pct(72) == 100
    assert refund_pct(30) == 75
    assert refund_pct(5) == 50
