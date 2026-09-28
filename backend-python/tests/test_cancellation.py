"""Phase 16 — Python twin of tests/cancellation.test.js: settings-backed
policy (defaults, hour/percent bounds, audited update), customer tiers from
policy with the deduped REFUND ledger entry, pandit-side cancellation with
notice-window compensation, admin no-show and the idempotent no-show sweep."""
import json
import time

import pytest
from sqlalchemy import select

from tests.conftest import admin_login, login

pytestmark = pytest.mark.asyncio


def _day_plus(n: int) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(time.time() + n * 86400))


def _booking_body(o=None):
    o = o or {}
    return {"pujaId": "satyanarayan", "mode": "home", "date": _day_plus(20),
            "slot": "10:00 AM",
            "addr": {"line": "12 Test Street", "city": "Delhi NCR", "pin": "110001"},
            "panditId": "p1", "sam": [], "pra": [], **o}


async def _paid_booking(client, tok, o=None):
    r = await client.post("/api/bookings", headers={"Authorization": "Bearer " + tok},
                          json=_booking_body(o))
    assert r.status_code == 201, r.text
    return r.json()["booking"]


async def _mk_past_booking(db, booking_id="DPPAST1"):
    """Past-due paid booking crafted directly (the demo seeder has none)."""
    from app.models import Booking, Transaction
    db.add(Booking(id=booking_id, user_id="u1", puja_id="satyanarayan", mode="home",
                   date=_day_plus(-3), slot="10:00 AM",
                   addr=json.dumps({"line": "1 Old Street", "city": "Delhi NCR", "pin": "110001"}),
                   pandit_id="p1", pst="accepted", sam="[]", pra="[]", notes="", member="Self",
                   coupon="", q=json.dumps({"svc": 2000, "total": 2509}), status="Confirmed",
                   pay=json.dumps({"paid": True, "method": "UPI", "ref": "MOCKX1"}),
                   ops="{}", media="[]", created=int(time.time() * 1000), log="[]"))
    db.add(Transaction(type="SERVICE_PAYMENT", amount=2509, currency="INR", ref_table="bookings",
                       ref_id=booking_id, booking_id=booking_id, note="test",
                       created_at=int(time.time() * 1000)))
    await db.commit()


async def test_policy_crud_defaults_validation_audit(client):
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    r = await client.get("/api/admin/cancellation-policy", headers=aa)
    assert r.status_code == 200, r.text
    pol = r.json()["policy"]
    assert pol["fullPct"] == 100 and pol["partPct"] == 75 and pol["latePct"] == 50
    assert pol["noshowPct"] == 25 and pol["compPct"] == 50 and pol["noticeHours"] == 24
    tok = await login(client, "customer")
    assert (await client.get("/api/admin/cancellation-policy", headers={
        "Authorization": "Bearer " + tok})).status_code == 403, "admin-only"
    bad = await client.put("/api/admin/cancellation-policy", headers=aa,
                           json={"full": 30, "part": 60})
    assert bad.status_code == 400, "full must exceed part"
    bad2 = await client.put("/api/admin/cancellation-policy", headers=aa, json={"latePct": 101})
    assert bad2.status_code == 400, "percent fields are 0..100"
    ok = await client.put("/api/admin/cancellation-policy", headers=aa, json={
        "full": 72, "part": 48, "latePct": 40, "noshowPct": 30, "compPct": 60, "noticeHours": 12})
    assert ok.status_code == 200, ok.text
    assert ok.json()["policy"]["full"] == 72
    big = await client.put("/api/admin/cancellation-policy", headers=aa, json={"full": 500})
    assert big.status_code == 200 and big.json()["policy"]["full"] == 500, \
        "hour windows may exceed 100 (they are windows, not percentages)"
    audits = (await client.get("/api/admin/audit?limit=100", headers=aa)).json()["entries"]
    assert any(a["action"] == "settings.cancellation_policy" for a in audits), "policy update audited"
    await client.put("/api/admin/cancellation-policy", headers=aa, json={
        "full": 48, "part": 24, "latePct": 50, "noshowPct": 25, "compPct": 50, "noticeHours": 24})


async def test_customer_cancel_tiers_and_refund_ledger(client, db_session):
    from app.models import Transaction
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    tok = await login(client, "customer")
    b = await _paid_booking(client, tok)
    total = b["q"]["total"]
    c = await client.post(f"/api/bookings/{b['id']}/cancel", headers={"Authorization": "Bearer " + tok}, json={})
    assert c.status_code == 200, c.text
    assert c.json()["booking"]["refund"] == {"amt": total, "pct": 100, "state": "Initiated"}, \
        "full tier above the window"
    await db_session.rollback()
    refunds = (await db_session.execute(select(Transaction).where(
        Transaction.type == "REFUND", Transaction.booking_id == b["id"]))).scalars().all()
    assert len(refunds) == 1 and refunds[0].amount == -total
    # late tier honours the POLICY
    r = await client.put("/api/admin/cancellation-policy", headers=aa, json={"latePct": 33})
    assert r.status_code == 200
    b2 = await _paid_booking(client, tok, {"date": _day_plus(1), "slot": "06:00 AM"})
    c2 = await client.post(f"/api/bookings/{b2['id']}/cancel", headers={"Authorization": "Bearer " + tok}, json={})
    assert c2.json()["booking"]["refund"]["pct"] == 33, "policy latePct applied"
    await client.put("/api/admin/cancellation-policy", headers=aa, json={"latePct": 50})


async def test_pandit_cancel_and_no_show(client, db_session):
    from app.models import Payout, Transaction
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    ctok = await login(client, "customer")
    ptok = await login(client, "pandit")
    # noticeHours=0 -> compensation always
    await client.put("/api/admin/cancellation-policy", headers=aa, json={"noticeHours": 0})
    far = await _paid_booking(client, ctok, {"date": _day_plus(40)})
    cf = await client.post(f"/api/pandit/bookings/{far['id']}/cancel",
                           headers={"Authorization": "Bearer " + ptok}, json={"reason": "Family emergency"})
    assert cf.status_code == 200, cf.text
    body = cf.json()["booking"]
    assert body["status"] == "Cancelled" and body["panditId"], "pandit stays attributed"
    assert body["refund"]["pct"] == 100, "customer refunded at the standard tier"
    await db_session.rollback()
    comp = (await db_session.execute(select(Payout).where(
        Payout.booking_id == far["id"], Payout.id.like("POC%")))).scalars().all()
    assert comp, "compensation payout created outside the notice window"
    # noticeHours = a year -> every cancel is inside the window
    await client.put("/api/admin/cancellation-policy", headers=aa, json={"noticeHours": 8760})
    near = await _paid_booking(client, ctok)
    cn = await client.post(f"/api/pandit/bookings/{near['id']}/cancel",
                           headers={"Authorization": "Bearer " + ptok}, json={})
    assert cn.status_code == 200, cn.text
    await db_session.rollback()
    comp2 = (await db_session.execute(select(Payout).where(
        Payout.booking_id == near["id"], Payout.id.like("POC%")))).scalars().all()
    assert not comp2, "no compensation inside the notice window"
    await client.put("/api/admin/cancellation-policy", headers=aa, json={"noticeHours": 24})
    # started pujas cannot be pandit-cancelled; admin no-show closes them instead
    st = await _paid_booking(client, ctok)
    r = await client.post(f"/api/admin/bookings/{st['id']}/status", headers=aa, json={"status": "Started"})
    assert r.status_code == 200, r.text
    refused = await client.post(f"/api/pandit/bookings/{st['id']}/cancel",
                                headers={"Authorization": "Bearer " + ptok}, json={})
    assert refused.status_code == 400, "started is refused"
    ns = await client.post(f"/api/admin/bookings/{st['id']}/noshow", headers=aa, json={"reason": "test"})
    assert ns.status_code == 200, ns.text
    assert ns.json()["booking"]["status"] == "Cancelled"
    await db_session.rollback()
    refunds = (await db_session.execute(select(Transaction).where(
        Transaction.type == "REFUND", Transaction.booking_id == st["id"]))).scalars().all()
    assert len(refunds) == 1 and refunds[0].amount == -round(st["q"]["total"] * 25 / 100), \
        "no-show customer refund at noshowPct"
    audits = (await client.get("/api/admin/audit?limit=200", headers=aa)).json()["entries"]
    acts = {a["action"] for a in audits}
    assert {"booking.cancelled_by_pandit", "booking.noshow", "booking.cancelled"} <= acts


async def test_no_show_sweep_idempotent(client, db_session):
    from app.models import Booking, Payout, Transaction
    from app.services.cancellation import pandit_no_show_sweep
    await _mk_past_booking(db_session)
    first = await pandit_no_show_sweep(db_session, None)
    await db_session.commit()
    assert "DPPAST1" in first, "past-due booking swept"
    row = await db_session.get(Booking, "DPPAST1")
    assert row.status == "Cancelled"
    assert json.loads(row.refund)["pct"] == 25, "customer refunded at noshowPct"
    comp = (await db_session.execute(select(Payout).where(
        Payout.booking_id == "DPPAST1", Payout.id.like("POC%")))).scalars().all()
    assert comp and comp[0].amount > 0, "pandit compensation payout created"
    second = await pandit_no_show_sweep(db_session, None)
    await db_session.commit()
    assert "DPPAST1" not in second, "sweep is idempotent"
    refunds = (await db_session.execute(select(Transaction).where(
        Transaction.type == "REFUND", Transaction.booking_id == "DPPAST1"))).scalars().all()
    assert len(refunds) == 1, "no double refund"
