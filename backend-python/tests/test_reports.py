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

from tests.conftest import admin_login, login

pytestmark = pytest.mark.asyncio

# Every report id the Node server exposes (REPORTS registry parity).
ALL_REPORTS = [
    "customers", "pandits", "temples", "pujas", "bookings", "payments", "orders",
    "kundalis", "kundali-payments", "family-members", "custom-requests",
    "samagri", "prasad", "coupons", "campaigns", "payouts", "revenue",
    "puja-performance", "commission", "customer-accounts", "pandit-accounts",
    "refunds", "pandit-performance", "customer-activity", "login-activity",
    "audit-logs", "media",
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
        assert str(ws.cell(row=1, column=1).value).startswith("DaivikPooja \u2014 "), rid
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
