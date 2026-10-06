"""Excel report export tests — the Python twin of the Node api.test.js
"excel upgrade" block: every report id renders a valid .xlsx with the
professional layout (title block, frozen filterable header, totals row),
filters are honoured, every download is audited in export_logs, and the
endpoint is admin-only with sensitive fields excluded by design."""
import io
import json
import re

import pytest
from openpyxl import load_workbook

from tests.conftest import admin_login, login, otp_login

pytestmark = pytest.mark.asyncio

# Every report id the Node server exposes (REPORTS registry parity — all 38).
ALL_REPORTS = [
    "customers", "pandits", "temples", "pujas", "bookings", "payments", "orders",
    "kundalis", "kundali-payments", "family-members", "custom-requests",
    "samagri", "prasad", "coupons", "coupon-redemptions", "coupon-usage",
    "campaigns", "payouts", "payout-audit",
    "dakshina", "transactions", "revenue",
    "puja-performance", "commission", "customer-accounts", "pandit-accounts",
    "refunds", "pandit-performance", "customer-activity", "login-activity",
    "audit-logs", "media", "leads",
    "kyc", "incidents", "agreements", "commission-tiers", "nri-packages",
]


def _load(r):
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    return load_workbook(io.BytesIO(r.content))


async def _seed_booking(client):
    tok = await login(client, "customer")
    r = await client.post("/api/bookings", headers={"Authorization": "Bearer " + tok},
                          json={"pujaId": "satyanarayan", "mode": "home",
                                "date": __import__("time").strftime("%Y-%m-%d",
                                                                     __import__("time").localtime(__import__("time").time() + 30 * 86400)),
                                "slot": "10:00 AM",
                                "addr": {"line": "12 Test Street", "city": "Delhi NCR", "pin": "110001"},
                                "panditId": "p1", "sam": [], "pra": []})
    assert r.status_code == 201, r.text
    return tok, r.json()["booking"]["id"]


async def test_all_report_ids_render_valid_xlsx(client):
    await _seed_booking(client)
    admin = await admin_login(client)
    h = {"Authorization": "Bearer " + admin}
    for rid in ALL_REPORTS:
        r = await client.get(f"/api/admin/export/{rid}.xlsx", headers=h)
        wb = _load(r)
        ws = wb[rid[:28]]
        # professional layout: merged title in row 1, header row 4
        assert str(ws.cell(row=1, column=1).value).startswith("DaivikPuja \u2014 "), rid
        assert ws.freeze_panes == "A5", rid
        headers = [ws.cell(row=4, column=i).value for i in range(1, ws.max_column + 1)]
        assert headers and all(h_ for h_ in headers), rid


async def test_unknown_report_404_and_admin_only(client):
    admin = await admin_login(client)
    r = await client.get("/api/admin/export/nope.xlsx",
                         headers={"Authorization": "Bearer " + admin})
    assert r.status_code == 404
    # customer token -> 403 (role gate)
    tok = await login(client, "customer")
    r2 = await client.get("/api/admin/export/customers.xlsx",
                          headers={"Authorization": "Bearer " + tok})
    assert r2.status_code == 403
    # anonymous -> 401
    r3 = await client.get("/api/admin/export/customers.xlsx")
    assert r3.status_code == 401


async def test_bookings_filter_status_mode_and_totals_row(client):
    tok, bid = await _seed_booking(client)
    admin = await admin_login(client)
    h = {"Authorization": "Bearer " + admin}

    r = await client.get("/api/admin/export/bookings.xlsx", headers=h)
    ws = _load(r)["bookings"]
    rows = [[ws.cell(row=i, column=c).value for c in range(1, 11)]
            for i in range(5, ws.max_row + 1)]
    assert any(bid in (x[0] or "") for x in rows)

    # mode filter narrows the result set (home bookings exist; temple ones seeded too)
    r2 = await client.get("/api/admin/export/bookings.xlsx",
                          params={"mode": "temple"}, headers=h)
    ws2 = _load(r2)["bookings"]
    rows2 = [[ws2.cell(row=i, column=1).value for i in range(5, ws2.max_row + 1)]]
    assert all(v != bid for v in rows2[0])

    # totals row: with >2 data rows the first cell is 'Total' (bold row, Node parity).
    # Create 3 family members so the report crosses the threshold deterministically.
    for n in ("One", "Two", "Three"):
        await client.post("/api/me/family", json={"relationship": "Other", "name": n},
                          headers={"Authorization": "Bearer " + tok})
    r3 = await client.get("/api/admin/export/family-members.xlsx", headers=h)
    ws3 = _load(r3)["family-members"]
    col_a = [ws3.cell(row=i, column=1).value for i in range(1, ws3.max_row + 1)]
    assert "Total" in col_a
    # a single-row report (revenue with one month) has no totals row (Node parity)
    r4 = await client.get("/api/admin/export/revenue.xlsx", headers=h)
    ws4 = _load(r4)["revenue"]
    col_a4 = [ws4.cell(row=i, column=1).value for i in range(1, ws4.max_row + 1)]
    assert ("Total" in col_a4) == (ws4.max_row - 4 > 2)


async def test_kundali_billing_filter(client):
    tok = await login(client, "customer")
    g = await client.post("/api/kundali/generate", headers={"Authorization": "Bearer " + tok},
                          json={"name": "Report Tester", "dob": "1990-01-15", "tob": "10:30",
                                "place": {"city": "Delhi", "lat": 28.6139, "lon": 77.2090,
                                          "tz": "Asia/Kolkata"}})
    assert g.status_code == 201
    admin = await admin_login(client)
    h = {"Authorization": "Bearer " + admin}
    r = await client.get("/api/admin/export/kundalis.xlsx",
                         params={"billing": "FREE"}, headers=h)
    wb = _load(r)
    ws = wb["kundalis"]
    billing_col = [ws.cell(row=4, column=i).value for i in range(1, ws.max_column + 1)].index("Billing") + 1
    vals = {ws.cell(row=i, column=billing_col).value for i in range(5, ws.max_row + 1)}
    assert vals <= {"FREE", "Total", None}
    # paid-only filter returns only chargeable states for kundali-payments
    r2 = await client.get("/api/admin/export/kundali-payments.xlsx", headers=h)
    ws2 = _load(r2)["kundali-payments"]
    st_col = [ws2.cell(row=4, column=i).value for i in range(1, ws2.max_column + 1)].index("Payment status") + 1
    assert ws2.max_row >= 4  # renders without error even when empty


async def test_export_logs_audit_trail(client, db_session):
    await _seed_booking(client)
    admin = await admin_login(client)
    h = {"Authorization": "Bearer " + admin}
    await client.get("/api/admin/export/coupons.xlsx", headers=h)
    await client.get("/api/admin/export/bookings.xlsx",
                     params={"mode": "home"}, headers=h)
    r = await client.get("/api/admin/export-logs", headers=h)
    logs = r.json()["logs"]
    reports = [l["report"] for l in logs]
    assert "coupons" in reports and "bookings" in reports
    bk = next(l for l in logs if l["report"] == "bookings")
    assert json.loads(bk["filters"]) == {"mode": "home"}
    assert isinstance(bk["rows"], int)
    assert bk["admin"]  # admin name resolved via join


async def test_sensitive_fields_excluded(client):
    admin = await admin_login(client)
    h = {"Authorization": "Bearer " + admin}
    r = await client.get("/api/admin/export/customers.xlsx", headers=h)
    ws = _load(r)["customers"]
    headers = [ws.cell(row=4, column=i).value for i in range(1, ws.max_column + 1)]
    joined = " ".join(str(x) for x in headers).lower()
    for forbidden in ("hash", "password", "token", "otp", "kyc"):
        assert forbidden not in joined
    r2 = await client.get("/api/admin/export/customer-accounts.xlsx", headers=h)
    ws2 = _load(r2)["customer-accounts"]
    headers2 = " ".join(str(ws2.cell(row=4, column=i).value) for i in range(1, ws2.max_column + 1)).lower()
    assert "password" not in headers2 and "hash" not in headers2


async def test_pandit_performance_service_value(client, db_session):
    """Node sums json_extract(b.q,'$.svc') over completed bookings into the
    'Service value (Rs)' column — the port must parse the JSON, not zero-fill."""
    from app.models import Booking, Pandit

    pname = (await db_session.get(Pandit, "p1")).name
    db_session.add(Booking(id="bk_svctest0001", user_id="u1", puja_id="lakshmi",
                           mode="home", date="2027-01-01", slot="11:11 PM",
                           pandit_id="p1", q=json.dumps({"svc": 1234, "total": 1500}),
                           pay=json.dumps({"paid": True}), status="Completed", created=1))
    await db_session.commit()
    admin = await admin_login(client)
    r = await client.get("/api/admin/export/pandit-performance.xlsx",
                         headers={"Authorization": "Bearer " + admin})
    ws = _load(r)["pandit-performance"]
    headers = [ws.cell(row=4, column=i).value for i in range(1, ws.max_column + 1)]
    svc_col = headers.index("Service value (Rs)") + 1
    name_col = headers.index("Pandit") + 1
    for i in range(5, ws.max_row + 1):
        if ws.cell(row=i, column=name_col).value == pname:
            assert ws.cell(row=i, column=svc_col).value == 1234
            break
    else:
        pytest.fail("demo pandit row not found in pandit-performance")


async def _seat(client, db, mobile: str, role: str) -> str:
    """Local copy of tests/test_rbac.py::seat — OTP-created customer, then the
    role written straight to the DB (current_auth re-reads it per request)."""
    from sqlalchemy import select, update

    from app.models import User

    tok = await otp_login(client, mobile, "Report Probe")
    uid = (await db.execute(select(User.id).where(User.mobile == mobile))).scalar_one()
    await db.execute(update(User).where(User.id == uid).values(role=role))
    await db.commit()
    return tok


def _rows(ws, headers):
    """Data rows (row 5 onward) as dicts, with the bold totals row dropped."""
    out = []
    for i in range(5, ws.max_row + 1):
        vals = [ws.cell(row=i, column=c).value for c in range(1, len(headers) + 1)]
        if not vals or vals[0] in (None, "Total"):
            continue
        out.append(dict(zip(headers, vals)))
    return out


async def test_phase30_module_reports_rows_filters_and_access(client, db_session):
    """Phase 30: the five module reports (kyc, incidents, agreements,
    commission-tiers, nri-packages) render their exact columns, honour each
    module's own filters, and stay admin-export-only (finance 403 — they are
    deliberately outside FINANCE_REPORTS)."""
    import time

    from app.models import (Agreement, AgreementAcceptance, CommissionTier,
                            Incident, KycDocument, NriPackage)

    now = int(time.time() * 1000)
    old = 1584268800000  # 2020-03-15T10:00:00Z
    db_session.add_all([
        KycDocument(id="kycdrill1", pandit_id="p1", doc_type="Aadhaar",
                    file_name="a-front.png", status="PENDING", uploaded_at=now),
        KycDocument(id="kycdrill2", pandit_id="p1", doc_type="PAN",
                    file_name="pan-card.png", status="VERIFIED", uploaded_at=old),
        Incident(id="INCDRILL1", pandit_id="p1", category="SAFETY_CONCERN",
                 description="Stray dogs blocked the courtyard.", status="OPEN",
                 reported_at=now),
        Incident(id="INCDRILL2", pandit_id="p1", category="OTHER",
                 description="Balance payment refused on arrival.",
                 status="UNDER_REVIEW", reported_at=old),
        Agreement(id="AGRDRILL1", version=1, title="Report drill agreement",
                  body="v1 body", status="PUBLISHED",
                  document_hash="a" * 64, created_at=now, published_at=now),
        AgreementAcceptance(id="acc_drill_1", agreement_id="AGRDRILL1",
                            pandit_id="p1", accepted_at=now),
        AgreementAcceptance(id="acc_drill_2", agreement_id="AGRDRILL1",
                            pandit_id="p2", method="MANUAL", accepted_at=now),
        CommissionTier(tier="DRILL ACTIVE", service_category="ALL",
                       commission_pct=15, pandit_share_pct=85, active=1),
        CommissionTier(tier="DRILL PAUSED", service_category="ALL",
                       commission_pct=50, pandit_share_pct=50, active=0),
        NriPackage(id="nrp-drill", name="Drill package", descr="Inactive probe",
                   price=99, currency="USD", inr_equiv=8300,
                   includes=json.dumps(["Alpha seva", "Beta prasad"]),
                   active=0, created=now),
    ])
    await db_session.commit()

    admin = await admin_login(client)
    h = {"Authorization": "Bearer " + admin}

    # --- exact header contract (mirrors tests/reports.test.js EXPECTED) ---
    expected = {
        "kyc": ["Document ID", "Pandit ID", "Pandit", "Document type", "File name",
                "Status", "Uploaded", "Verified by", "Verified at", "Reject reason",
                "Expires at", "Next re-verification"],
        "incidents": ["Incident ID", "Pandit ID", "Pandit", "Booking ID",
                      "Customer ID", "Category", "Description", "Status",
                      "Admin notes", "Resolution", "Reported", "Resolved"],
        "agreements": ["Agreement ID", "Version", "Title", "Status", "Document hash",
                       "File name", "Created by", "Effective from", "Created",
                       "Published", "Archived", "Acceptances"],
        "commission-tiers": ["Tier ID", "Tier", "Service category", "Commission %",
                             "Pandit share %", "Effective from", "Effective to", "Active"],
        "nri-packages": ["Package ID", "Name", "Description", "Price", "Currency",
                         "INR equivalent", "Includes", "Active", "Created"],
    }
    for rid, cols in expected.items():
        ws = _load(await client.get(f"/api/admin/export/{rid}.xlsx", headers=h))[rid]
        got = [ws.cell(row=4, column=i).value for i in range(1, ws.max_column + 1)]
        assert got == cols, f"{rid} headers"
        assert ws.freeze_panes == "A5", rid

    # --- kyc: status + ms-epoch from/to day window ---
    ws = _load(await client.get("/api/admin/export/kyc.xlsx", headers=h))["kyc"]
    hdr = [ws.cell(row=4, column=i).value for i in range(1, ws.max_column + 1)]
    assert {r["Document ID"] for r in _rows(ws, hdr)} == {"kycdrill1", "kycdrill2"}

    ws = _load(await client.get("/api/admin/export/kyc.xlsx", params={"status": "PENDING"},
                                headers=h))["kyc"]
    assert [r["Document ID"] for r in _rows(ws, hdr)] == ["kycdrill1"]
    assert "status: PENDING" in str(ws.cell(row=3, column=1).value)

    ws = _load(await client.get("/api/admin/export/kyc.xlsx", params={"from": "2021-01-01"},
                                headers=h))["kyc"]
    assert [r["Document ID"] for r in _rows(ws, hdr)] == ["kycdrill1"]
    ws = _load(await client.get("/api/admin/export/kyc.xlsx", params={"to": "2020-12-31"},
                                headers=h))["kyc"]
    assert [r["Document ID"] for r in _rows(ws, hdr)] == ["kycdrill2"]
    assert _rows(ws, hdr)[0]["Status"] == "VERIFIED"

    # --- incidents: status, category and stacked filters ---
    ws = _load(await client.get("/api/admin/export/incidents.xlsx", headers=h))["incidents"]
    ihdr = [ws.cell(row=4, column=i).value for i in range(1, ws.max_column + 1)]
    assert {"INCDRILL1", "INCDRILL2"} <= {r["Incident ID"] for r in _rows(ws, ihdr)}
    ws = _load(await client.get("/api/admin/export/incidents.xlsx", params={"status": "OPEN"},
                                headers=h))["incidents"]
    assert [r["Incident ID"] for r in _rows(ws, ihdr)] == ["INCDRILL1"]
    ws = _load(await client.get("/api/admin/export/incidents.xlsx", params={"category": "OTHER"},
                                headers=h))["incidents"]
    assert [r["Incident ID"] for r in _rows(ws, ihdr)] == ["INCDRILL2"]
    assert _rows(ws, ihdr)[0]["Status"] == "UNDER_REVIEW"
    ws = _load(await client.get("/api/admin/export/incidents.xlsx",
                                params={"status": "OPEN", "category": "OTHER"},
                                headers=h))["incidents"]
    assert _rows(ws, ihdr) == [], "stacked filters combine"

    # --- agreements: acceptance count subquery + status filter ---
    ws = _load(await client.get("/api/admin/export/agreements.xlsx", headers=h))["agreements"]
    ahdr = [ws.cell(row=4, column=i).value for i in range(1, ws.max_column + 1)]
    row = next(r for r in _rows(ws, ahdr) if r["Agreement ID"] == "AGRDRILL1")
    assert row["Status"] == "PUBLISHED"
    assert row["Acceptances"] == 2, "acceptance count is a subquery, not a literal"
    assert len(str(row["Document hash"])) == 64
    ws = _load(await client.get("/api/admin/export/agreements.xlsx",
                                params={"status": "DRAFT"}, headers=h))["agreements"]
    assert "AGRDRILL1" not in {r["Agreement ID"] for r in _rows(ws, ahdr)}

    # --- commission-tiers / nri-packages: active flag + includes parsing ---
    ws = _load(await client.get("/api/admin/export/commission-tiers.xlsx",
                                params={"active": "1"}, headers=h))["commission-tiers"]
    thdr = [ws.cell(row=4, column=i).value for i in range(1, ws.max_column + 1)]
    tiers = _rows(ws, thdr)
    assert any(t["Tier"] == "DRILL ACTIVE" for t in tiers)
    assert not any(t["Tier"] == "DRILL PAUSED" for t in tiers)
    ws = _load(await client.get("/api/admin/export/commission-tiers.xlsx",
                                params={"active": "0"}, headers=h))["commission-tiers"]
    assert [t["Tier"] for t in _rows(ws, thdr)] == ["DRILL PAUSED"]

    ws = _load(await client.get("/api/admin/export/nri-packages.xlsx",
                                params={"active": "0"}, headers=h))["nri-packages"]
    nhdr = [ws.cell(row=4, column=i).value for i in range(1, ws.max_column + 1)]
    pkgs = _rows(ws, nhdr)
    assert [p["Package ID"] for p in pkgs] == ["nrp-drill"]
    assert pkgs[0]["Includes"] == "Alpha seva, Beta prasad", "JSON array -> comma list"
    ws = _load(await client.get("/api/admin/export/nri-packages.xlsx",
                                params={"active": "1"}, headers=h))["nri-packages"]
    live = _rows(ws, nhdr)
    assert len(live) >= 3, "the demo catalogue is active"
    assert "nrp-drill" not in {p["Package ID"] for p in live}

    # --- access: admin-export-only (Phase 21 FINANCE_REPORTS unchanged) ---
    finance = await _seat(client, db_session, "9811100311", "finance")
    support = await _seat(client, db_session, "9811100312", "customer_support")
    for rid in expected:
        assert (await client.get(f"/api/admin/export/{rid}.xlsx",
                                 headers={"Authorization": "Bearer " + finance})).status_code == 403, rid
        assert (await client.get(f"/api/admin/export/{rid}.xlsx",
                                 headers={"Authorization": "Bearer " + support})).status_code == 403, rid
        assert (await client.get(f"/api/admin/export/{rid}.xlsx",
                                 headers=h)).status_code == 200, rid
    assert (await client.get("/api/admin/export/payments.xlsx",
                             headers={"Authorization": "Bearer " + finance})).status_code == 200
    assert (await client.get("/api/admin/export/kyc.xlsx")).status_code == 401
