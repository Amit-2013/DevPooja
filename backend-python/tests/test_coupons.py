"""Phase 14 — Python twin of tests/coupons.test.js: coupon scoping
(ALL|PUJA|KUNDALI), validity window, per-puja restriction, per-user cap
counted at the money moment, cart (shop orders) redemption, admin
GET/create/toggle surface, audits, access."""
import pytest
from sqlalchemy import func, select

from app.models import Coupon, CouponRedemption, Kundali
from tests.conftest import admin_login, day_plus, login, otp_login

pytestmark = pytest.mark.asyncio


async def _coupon(client, aa, code, **over):
    body = {"code": code, "type": "flat", "val": 50, "max": 50, "min": 0}
    body.update(over)
    return await client.post("/api/admin/coupons", headers=aa, json=body)


async def test_admin_coupon_surface(client, db_session):
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    listed = await client.get("/api/admin/coupons", headers=aa)
    assert listed.status_code == 200
    coupons = listed.json()["coupons"]
    assert len(coupons) >= 3, "seeded coupons listed"
    assert all(c["scope"] == "ALL" and c["per_user"] == 0 for c in coupons), "backfilled scope/per_user"

    r = await _coupon(client, aa, "PujaOnly", val=150, max=150, min=500,
                      scope="PUJA", pujaId="satyanarayan", perUser=2)
    assert r.status_code == 201, r.text
    row = await db_session.get(Coupon, "PUJAONLY")
    assert row.scope == "PUJA"
    assert row.puja_id == "satyanarayan"
    assert row.per_user == 2

    assert (await _coupon(client, aa, "BADSCOPE", scope="NRI")).status_code == 400, "scope whitelist"
    assert (await _coupon(client, aa, "BADPUJA", scope="PUJA", pujaId="nope")).status_code == 400, "unknown puja"
    assert (await _coupon(client, aa, "BADWIN", val=10, max=10, min=0, starts="2020-01-01", expires="2020-01-01")).status_code == 400, "start must precede expiry"

    # toggle + audits + access
    t = (await client.patch("/api/admin/coupons/PUJAONLY", headers=aa, json={"active": False}))
    assert t.status_code == 200
    db_session.expire_all()
    assert (await db_session.get(Coupon, "PUJAONLY")).active == 0
    logs = (await client.get("/api/admin/audit", headers=aa)).json()["entries"]
    assert any(e["action"] == "coupon.create" and e["entityId"] == "PUJAONLY" for e in logs)
    assert any(e["action"] == "coupon.toggle" and e["entityId"] == "PUJAONLY" for e in logs)

    ct = {"Authorization": "Bearer " + await login(client, "customer")}
    assert (await client.get("/api/admin/coupons", headers=ct)).status_code == 403
    assert (await client.get("/api/admin/coupons")).status_code == 401


async def test_scope_enforcement_and_kundali_redemption(client, db_session):
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    await _coupon(client, aa, "KundOnly", val=50, max=50, min=300, scope="KUNDALI")
    ct = {"Authorization": "Bearer " + await login(client, "customer")}

    quoted = await client.post("/api/quote", headers=ct,
                               json={"pujaId": "satyanarayan", "mode": "home", "sam": [], "pra": [], "coupon": "KUNDONLY"})
    assert quoted.json()["couponError"] == "This coupon does not apply to this purchase."

    booked = await client.post("/api/bookings", headers=ct,
                               json={"pujaId": "satyanarayan", "mode": "home", "date": day_plus(31),
                                     "slot": "10:00 AM", "addr": {"line": "12 Test Street", "city": "Delhi NCR", "pin": "110001"},
                                     "panditId": "p1", "sam": [], "pra": [], "coupon": "KUNDONLY"})
    assert booked.status_code == 400
    assert booked.json()["detail"] == "This coupon does not apply to this purchase."

    cart = await client.post("/api/orders/coupon", headers=ct,
                             json={"code": "KUNDONLY", "items": [{"k": "k_basic", "q": 1}]})
    assert cart.status_code == 200
    assert cart.json()["problem"], "cart refuses KUNDALI scope"

    # kundali accepts it — burn the free personal quota first (plan gives 1)
    tok2 = await otp_login(client, "9000044444", "Coupon Devotee")
    ct2 = {"Authorization": "Bearer " + tok2}
    birth = {"name": "X", "dob": "1992-03-03", "tob": "09:15", "save": False,
             "place": {"city": "Delhi", "state": "Delhi", "country": "India",
                       "lat": 28.6139, "lon": 77.2090, "tz": "Asia/Kolkata"}}
    for i in range(2):
        await client.post("/api/kundali/generate", headers=ct2, json={**birth, "name": f"Quota {i}"})
    gen = await client.post("/api/kundali/generate", headers=ct2, json={**birth, "name": "Coupon Tester", "coupon": "KundOnly"})
    assert gen.status_code == 201, gen.text
    assert gen.json()["billing"]["state"] == "PAID"
    kid = gen.json()["kundaliId"]
    db_session.expire_all()
    kd = await db_session.get(Kundali, kid)
    assert kd.coupon == "KUNDONLY"
    assert kd.discount >= 50, "coupon discount applied"
    red = (await db_session.execute(select(CouponRedemption).where(
        CouponRedemption.code == "KUNDONLY", CouponRedemption.source == "kundali"))).scalar_one()
    assert red.user_id and red.ref_id == kid


async def test_window_and_per_user_cap_via_cart(client, db_session):
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    await _coupon(client, aa, "Expired", val=100, max=100, min=300, expires="2020-01-01")
    await _coupon(client, aa, "TwiceOnly", val=20, max=20, min=0, perUser=2)
    ct = {"Authorization": "Bearer " + await login(client, "customer")}

    q = await client.post("/api/quote", headers=ct,
                          json={"pujaId": "satyanarayan", "mode": "home", "sam": [], "pra": [], "coupon": "EXPIRED"})
    assert q.json()["couponError"] == "This coupon has expired."

    cart = {"items": [{"k": "k_basic", "q": 1}], "address": "12 Test Street", "city": "Delhi NCR"}
    o1 = await client.post("/api/orders", headers=ct, json={**cart, "coupon": "TwiceOnly"})
    assert o1.status_code == 201, o1.text
    assert o1.json()["order"]["coupon"] == "TWICEONLY"
    assert o1.json()["order"]["discount"] >= 20
    o2 = await client.post("/api/orders", headers=ct, json={**cart, "coupon": "TWICEONLY"})
    assert o2.status_code == 201
    o3 = await client.post("/api/orders", headers=ct, json={**cart, "coupon": "TWICEONLY"})
    assert o3.status_code == 400
    assert o3.json()["detail"] == "You have already used this coupon the maximum number of times."
    reds = (await db_session.execute(select(CouponRedemption).where(
        CouponRedemption.code == "TWICEONLY", CouponRedemption.source == "order"))).scalars().all()
    assert len(reds) == 2, "one redemption per order, tracked per user"


async def test_puja_scope_restriction(client, db_session):
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    await _coupon(client, aa, "SatOnly", type="pct", val=10, max=200, min=1000, scope="PUJA", pujaId="satyanarayan")
    ct = {"Authorization": "Bearer " + await login(client, "customer")}

    ok = await client.post("/api/quote", headers=ct,
                           json={"pujaId": "satyanarayan", "mode": "home", "sam": [], "pra": [], "coupon": "SATONLY"})
    assert ok.json()["couponError"] == ""
    other = await client.post("/api/quote", headers=ct,
                              json={"pujaId": "vivah", "mode": "home", "sam": [], "pra": [], "coupon": "SATONLY"})
    assert other.json()["couponError"] == "This coupon applies to a different puja."


async def test_booking_redemption_recorded(client, db_session):
    tok = await otp_login(client, "9000055555", "Booking Coupon")
    ct = {"Authorization": "Bearer " + tok}
    b = await client.post("/api/bookings", headers=ct,
                          json={"pujaId": "satyanarayan", "mode": "home", "date": day_plus(33),
                                "slot": "10:00 AM", "addr": {"line": "12 Test Street", "city": "Delhi NCR", "pin": "110001"},
                                "panditId": "p1", "sam": [], "pra": [], "coupon": "FIRST100"})
    assert b.status_code == 201, b.text
    bid = b.json()["booking"]["id"]
    row = (await db_session.execute(select(CouponRedemption).where(
        CouponRedemption.source == "booking", CouponRedemption.ref_id == bid))).scalar_one()
    assert row.code == "FIRST100"
