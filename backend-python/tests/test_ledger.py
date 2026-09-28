"""Phases 9-10 — Python twin of tests/ledger.test.js: the typed `transactions`
ledger (record validation, dedupe idempotency, totals sign convention) and the
effective-dated commission tiers (window/category precedence, CRUD validation,
audit trail) wiring into the payment, booking, kundali and payout money paths,
plus the new dakshina/transactions reports.

Unlike the Node harness (one DB per file run), conftest.py rebuilds the DB for
every test — so there is no cross-test tier pollution to clean up, only the
tier state a single test creates itself."""
import io
import time

import pytest
from fastapi import HTTPException
from openpyxl import load_workbook
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


async def _booking(client, token, day, h):
    r = await client.post("/api/bookings", headers=h,
                          json=_booking_body({"date": _day_plus(day)}))
    assert r.status_code == 201, r.text
    return r.json()["booking"]


async def _pay(client, bid, h):
    r = await client.post("/api/payments/verify", headers=h, json={
        "bookingId": bid, "razorpay_order_id": "o_" + bid,
        "razorpay_payment_id": "p_" + bid, "razorpay_signature": "sig_" + bid})
    assert r.status_code == 200, r.text


async def _deactivate_all_tiers(db):
    from app.models import CommissionTier
    rows = (await db.execute(select(CommissionTier).where(CommissionTier.active == 1))).scalars()
    for t in rows:
        t.active = 0
    await db.commit()


async def _payout_lifecycle(client, aa, tok, day, db):
    """Book -> pay -> complete -> payout PENDING -> process -> disburse."""
    ch = {"Authorization": "Bearer " + tok}
    b = await _booking(client, tok, day, ch)
    await _pay(client, b["id"], ch)
    r = await client.post(f"/api/admin/bookings/{b['id']}/status", headers=aa,
                          json={"status": "Completed"})
    assert r.status_code == 200, r.text
    from app.models import Payout
    await db.rollback()  # drop any stale read snapshot before reading
    po = (await db.execute(select(Payout).where(Payout.booking_id == b["id"])
                           .order_by(Payout.id.desc()))).scalars().first()
    assert po, "payout row created for the completed booking"
    pr = await client.post(f"/api/admin/payouts/{po.id}/process", headers=aa, json={})
    assert pr.status_code == 200, pr.text
    d = await client.post(f"/api/admin/payouts/{po.id}/disburse", headers=aa,
                          json={"utr": "UTR" + str(po.id)[-6:]})
    assert d.status_code == 200, d.text
    return b, str(po.id), d.json()["payout"]["amt"]


async def test_ledger_service_record_dedupe_totals(db_session):
    from app.services import ledger as LEDGER
    with pytest.raises(HTTPException):
        await LEDGER.record(db_session, type="NOPE", amount=100)
    with pytest.raises(HTTPException):
        await LEDGER.record(db_session, type="DAKSHINA", amount=0)

    a = await LEDGER.record(db_session, type="DAKSHINA", amount=501, pandit_id="p1",
                            ref_table="x", ref_id="r1")
    assert a
    b = await LEDGER.record(db_session, type="DAKSHINA", amount=501, pandit_id="p1",
                            ref_table="x", ref_id="r1")
    assert b != a, "record is the raw primitive — duplicates allowed"
    d1 = await LEDGER.dedupe(db_session, type="DAKSHINA", amount=501, pandit_id="p1",
                             ref_table="x", ref_id="r1")
    assert d1["deduped"] is True, "same (type,ref) dedupes"
    d2 = await LEDGER.dedupe(db_session, type="DAKSHINA", amount=999, pandit_id="p1",
                             ref_table="x", ref_id="r1")
    assert d2["deduped"] is True, "amount is ignored when the ref already exists"

    totals = await LEDGER.totals(db_session)
    assert totals["DAKSHINA"]["total"] == 1002, "501+501 exactly once each"
    assert totals["DAKSHINA"]["count"] == 2
    assert totals["_inflow"] >= 1002, "DAKSHINA counts as inflow"


async def test_tier_resolver_windows_and_precedence(db_session):
    from app.services import ledger as LEDGER
    await LEDGER.tier_create(db_session, None, {"tier": "GOLD", "serviceCategory": "ALL",
                                                "commissionPct": 15, "panditSharePct": 85,
                                                "effectiveFrom": "2026-01-01"})
    s = await LEDGER.tier_create(db_session, None, {"tier": "SILVER", "serviceCategory": "rudra",
                                                    "commissionPct": 25,
                                                    "effectiveFrom": "2026-02-01"})
    await LEDGER.tier_create(db_session, None, {"tier": "LEGACY", "serviceCategory": "ALL",
                                                "commissionPct": 30,
                                                "effectiveFrom": "2025-01-01",
                                                "effectiveTo": "2025-12-31"})
    await LEDGER.tier_create(db_session, None, {"tier": "PAUSED", "serviceCategory": "ALL",
                                                "commissionPct": 50,
                                                "effectiveFrom": "2026-01-01",
                                                "active": False})
    assert (await LEDGER.resolve_tier(db_session, "p1", "rudra", "2026-03-01"))["tier"] == "SILVER"
    assert (await LEDGER.resolve_tier(db_session, "p1", "ganesh", "2026-03-01"))["tier"] == "GOLD"
    assert await LEDGER.resolve_tier(db_session, "p1", "ganesh", "2024-06-15") is None
    await LEDGER.tier_create(db_session, None, {"tier": "PLATINUM", "serviceCategory": "ALL",
                                                "commissionPct": 10,
                                                "effectiveFrom": "2026-03-01"})
    assert (await LEDGER.resolve_tier(db_session, "p1", "ganesh", "2026-04-01"))["tier"] == "PLATINUM"
    assert (await LEDGER.resolve_tier(db_session, "p1", "ganesh", "2026-02-01"))["tier"] == "GOLD"

    hook = await LEDGER.commission_pct(db_session, pandit_id="p1", service_category="rudra")
    assert hook == {"pct": 25, "tier": "SILVER", "tierId": s["id"]}
    await _deactivate_all_tiers(db_session)
    fb = await LEDGER.commission_pct(db_session, pandit_id="p1", service_category="ganesh")
    assert fb["tier"] is None, "fallback has no tier"
    assert isinstance(fb["pct"], int), "settings fallback pct is a number"


async def test_tier_crud_validation_and_audit(client):
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    assert (await client.post("/api/admin/commission-tiers", headers=aa,
                              json={"commissionPct": 20})).status_code == 400, "tier name required"
    assert (await client.post("/api/admin/commission-tiers", headers=aa,
                              json={"tier": "X", "commissionPct": 91})).status_code == 400, "pct > 90"
    assert (await client.post("/api/admin/commission-tiers", headers=aa,
                              json={"tier": "X", "commissionPct": 60,
                                    "panditSharePct": 50})).status_code == 400, "pct+share > 100"
    ok = await client.post("/api/admin/commission-tiers", headers=aa, json={
        "tier": "BRONZE", "serviceCategory": "satyanarayan", "commissionPct": 20,
        "panditSharePct": 80})
    assert ok.status_code == 201, ok.text
    assert ok.json()["tier"]["commissionPct"] == 20
    upd = await client.patch(f"/api/admin/commission-tiers/{ok.json()['tier']['id']}",
                             headers=aa, json={"commissionPct": 18})
    assert upd.json()["tier"]["commissionPct"] == 18
    assert (await client.patch("/api/admin/commission-tiers/99999", headers=aa,
                               json={"commissionPct": 10})).status_code == 400, "unknown tier"
    tok = await login(client, "customer")
    assert (await client.get("/api/admin/commission-tiers", headers={
        "Authorization": "Bearer " + tok})).status_code == 403, "customers cannot read tiers"
    audits = (await client.get("/api/admin/audit?limit=300", headers=aa)).json()["entries"]
    acts = {a["action"] for a in audits}
    assert "commission.tier_created" in acts and "commission.tier_updated" in acts


async def test_service_payment_and_refund_ledger(client, db_session):
    from app.models import Transaction
    tok = await login(client, "customer")
    h = {"Authorization": "Bearer " + tok}
    b = await _booking(client, tok, 120, h)
    await _pay(client, b["id"], h)
    await db_session.rollback()
    rows = (await db_session.execute(
        select(Transaction).where(Transaction.type == "SERVICE_PAYMENT"))).scalars().all()
    mine = [r for r in rows if r.booking_id == b["id"]]
    assert mine, "SERVICE_PAYMENT row for the booking"
    assert mine[0].amount == b["q"]["total"], "row amount equals booking total"
    n0 = len(rows)
    await client.post("/api/payments/verify", headers=h, json={
        "bookingId": b["id"], "razorpay_order_id": "o_r", "razorpay_payment_id": "p_r",
        "razorpay_signature": "s_r"})
    await db_session.rollback()
    rows2 = (await db_session.execute(
        select(Transaction).where(Transaction.type == "SERVICE_PAYMENT"))).scalars().all()
    assert len(rows2) == n0, "payment retry does not double-count"

    c = await client.post(f"/api/bookings/{b['id']}/cancel", headers=h, json={})
    assert c.status_code == 200, c.text
    await db_session.rollback()
    refunds = (await db_session.execute(
        select(Transaction).where(Transaction.type == "REFUND"))).scalars().all()
    assert any(r.booking_id == b["id"] and r.amount < 0 for r in refunds), \
        "REFUND row signed negative on cancellation"


async def test_payout_lifecycle_ledger_and_tiers(client, db_session):
    from app.models import Transaction
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    tok = await login(client, "customer")
    await _deactivate_all_tiers(db_session)
    t = await client.post("/api/admin/commission-tiers", headers=aa, json={
        "tier": "LIFE", "serviceCategory": "Prosperity", "commissionPct": 30,
        "effectiveFrom": "2026-01-01"})
    assert t.status_code == 201, t.text

    b, po_id, net = await _payout_lifecycle(client, aa, tok, 130, db_session)
    await db_session.rollback()
    rows = (await db_session.execute(select(Transaction))).scalars().all()
    dsh = next((r for r in rows if r.type == "DAKSHINA" and r.booking_id == b["id"]), None)
    assert dsh, "DAKSHINA row exists at payout creation"
    assert dsh.amount == net, "DAKSHINA equals the pandit share"
    com = next((r for r in rows if r.type == "COMMISSION" and r.ref_id == po_id + ":commission"), None)
    assert com and com.amount == round(b["q"]["svc"] * 30 / 100), \
        "tier commission pct (30%) applied to the service fee"
    po = next((r for r in rows if r.type == "PAYOUT" and r.ref_id == po_id + ":payout"), None)
    assert po and po.amount == -net, "PAYOUT mirrors the share, signed negative"

    await _deactivate_all_tiers(db_session)
    r = await client.post("/api/admin/settings", headers=aa, json={"commission": 25})
    assert r.status_code == 200, r.text
    b2, po2, net2 = await _payout_lifecycle(client, aa, tok, 131, db_session)
    await db_session.rollback()
    rows = (await db_session.execute(select(Transaction))).scalars().all()
    com2 = next(r for r in rows if r.type == "COMMISSION" and r.ref_id == po2 + ":commission")
    assert com2.amount == round(b2["q"]["svc"] * 25 / 100), \
        "settings fallback pct (25%) applied without a tier"
    assert net2 == b2["q"]["svc"] - com2.amount, "net = service fee - commission under fallback"


async def test_kundali_payment_ledger(client, db_session):
    from app.models import Transaction
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    tok = await login(client, "customer")
    h = {"Authorization": "Bearer " + tok}
    fm = await client.post("/api/me/family", headers=h, json={
        "relationship": "Mother", "name": "Ledger Devi", "dob": "1965-07-04", "tob": "05:30",
        "gender": "female", "city": "Delhi", "state": "Delhi", "country": "India",
        "lat": 28.6139, "lon": 77.209, "tz": "Asia/Kolkata"})
    assert fm.status_code == 201, fm.text
    g = await client.post("/api/kundali/generate", headers=h, json={
        "familyMemberId": fm.json()["id"],
        "place": {"city": "Delhi", "lat": 28.6139, "lon": 77.209, "tz": "Asia/Kolkata"}})
    assert g.status_code == 201, g.text
    assert g.json()["billing"]["state"] == "PAID", "mock gateway settles immediately"
    await db_session.rollback()
    rows = (await db_session.execute(
        select(Transaction).where(Transaction.type == "KUNDALI_PAYMENT"))).scalars().all()
    kid = g.json()["kundaliId"]
    assert any(r.kundali_id == kid and r.amount > 0 for r in rows), \
        "mock-paid kundali writes KUNDALI_PAYMENT at generate"
    v = await client.post("/api/kundali/pay/verify", headers=h, json={"kundaliId": kid})
    assert v.status_code == 200, v.text
    await db_session.rollback()
    rows = (await db_session.execute(
        select(Transaction).where(Transaction.type == "KUNDALI_PAYMENT"))).scalars().all()
    assert len([r for r in rows if r.kundali_id == kid]) == 1, "verify replay does not double-count"
    assert aa  # admin token used above keeps the ledger routes exercised


async def test_dakshina_and_transactions_reports(client, db_session):
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    tok = await login(client, "customer")
    ch = {"Authorization": "Bearer " + tok}
    await _payout_lifecycle(client, aa, tok, 130, db_session)

    lv = (await client.get("/api/admin/ledger?limit=50", headers=aa)).json()
    assert lv["entries"], "ledger entries listed"
    assert isinstance(lv["totals"]["_inflow"], int), "totals returned with inflow split"
    tiers = (await client.get("/api/admin/commission-tiers", headers=aa)).json()["tiers"]
    assert isinstance(tiers, list), "tier list served"

    r = await client.get("/api/admin/export/dakshina.xlsx", headers=aa)
    assert r.status_code == 200, r.text
    ws = load_workbook(io.BytesIO(r.content))["dakshina"]
    headers = [ws.cell(row=4, column=i).value for i in range(1, ws.max_column + 1)]
    type_col, amt_col, pid_col = headers.index("Type") + 1, headers.index("Amount (Rs)") + 1, \
        headers.index("Pandit ID") + 1
    saw_pos = saw_neg = False
    for i in range(5, ws.max_row + 1):
        t_, a_, p_ = (ws.cell(row=i, column=type_col).value,
                      ws.cell(row=i, column=amt_col).value,
                      ws.cell(row=i, column=pid_col).value)
        if p_ == "p1" and t_ == "DAKSHINA" and (a_ or 0) > 0:
            saw_pos = True
        if p_ == "p1" and t_ == "PAYOUT" and (a_ or 0) < 0:
            saw_neg = True
    assert saw_pos and saw_neg, "dakshina positive, payout negative for p1"

    r2 = await client.get("/api/admin/export/transactions.xlsx",
                          params={"type": "PAYOUT"}, headers=aa)
    ws2 = load_workbook(io.BytesIO(r2.content))["transactions"]
    headers2 = [ws2.cell(row=4, column=i).value for i in range(1, ws2.max_column + 1)]
    tcol = headers2.index("Type") + 1
    vals = [ws2.cell(row=i, column=tcol).value for i in range(5, ws2.max_row + 1)]
    vals = [v for v in vals if v not in (None, "", "Total")]
    assert vals and all(v == "PAYOUT" for v in vals), "transactions type filter works"

    assert (await client.get("/api/admin/export/dakshina.xlsx", headers=ch)).status_code == 403, \
        "reports are admin-only"
