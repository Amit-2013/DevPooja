"""Phase 32 — Python twin of the dashboard-summary tests in tests/api.test.js.

The admin /state payload carries a `dash` block with the KPI numbers the
dashboard tiles render but the payload does not otherwise hold: pending
agreements (DRAFT versions), open incidents (OPEN + UNDER_REVIEW), kundalis
generated, campaigns, live leads (NEW/CONTACTED/QUALIFIED) and payout
pending/on-hold counts + amounts (twin of st.dash in server/lib/state.js).

Two invariants: the block rides the admin family ONLY (anon/customer/pandit
state never carries it), and every number agrees with the module endpoints (or
an independent DB query where Python has no Node-side endpoint twin).
"""
import pytest
from sqlalchemy import func, select

from app.models import Kundali
from tests.conftest import admin_login, login

pytestmark = pytest.mark.asyncio

T = "Bearer "


def h(tok: str) -> dict:
    return {"Authorization": T + tok}


DASH_KEYS = ["agreementsPending", "incidentsOpen", "kundalis", "campaigns", "leadsLive",
             "payoutPendingN", "payoutPendingAmt", "payoutOnHoldN", "payoutOnHoldAmt"]


async def test_dash_rides_the_family_payload_only(client):
    admin = await admin_login(client)
    st = (await client.get("/api/state", headers=h(admin))).json()
    assert "dash" in st, "admin state carries the dashboard summary"
    for k in DASH_KEYS:
        assert isinstance(st["dash"][k], (int, float)), k + " is numeric"
        assert st["dash"][k] >= 0, k + " is never negative"

    anon = (await client.get("/api/state")).json()
    assert "dash" not in anon, "anonymous state never carries the dashboard summary"
    cust = (await client.get("/api/state", headers=h(await login(client, "customer")))).json()
    assert "dash" not in cust, "customer state never carries the dashboard summary"
    pandit = (await client.get("/api/state", headers=h(await login(client, "pandit")))).json()
    assert "dash" not in pandit, "pandit state never carries the dashboard summary"


async def test_dash_numbers_agree_with_the_module_endpoints(client, db_session):
    admin = await admin_login(client)
    st = (await client.get("/api/state", headers=h(admin))).json()
    dash = st["dash"]

    agr = (await client.get("/api/admin/agreements", headers=h(admin))).json()
    drafts = sum(1 for a in agr["agreements"] if a["status"] == "DRAFT")
    assert dash["agreementsPending"] == drafts, "pending agreements = DRAFT versions"

    inc = (await client.get("/api/admin/incidents", headers=h(admin))).json()
    assert dash["incidentsOpen"] == inc["counts"].get("OPEN", 0) + inc["counts"].get("UNDER_REVIEW", 0), \
        "open incidents = OPEN + UNDER_REVIEW"

    assert dash["campaigns"] == len(st["campaigns"]), "campaigns agrees with the marketing rows"
    assert dash["leadsLive"] == sum(1 for l in st["leads"] if l["st"] in ("NEW", "CONTACTED", "QUALIFIED")), \
        "live leads = NEW + CONTACTED + QUALIFIED"
    pend = [p for p in st["payouts"] if p["st"] == "PENDING"]
    hold = [p for p in st["payouts"] if p["st"] == "ON_HOLD"]
    assert dash["payoutPendingN"] == len(pend), "pending payout count"
    assert dash["payoutPendingAmt"] == sum((p["amt"] or 0) for p in pend), "pending payout amount"
    assert dash["payoutOnHoldN"] == len(hold), "on-hold payout count"
    assert dash["payoutOnHoldAmt"] == sum((p["amt"] or 0) for p in hold), "on-hold payout amount"

    # Python has no /admin/kundali/analyses twin (Node-only overview endpoint),
    # so the count is pinned against an independent query over the same table.
    total = (await db_session.execute(select(func.count()).select_from(Kundali))).scalar() or 0
    assert dash["kundalis"] == total, "kundalis generated = rows in the kundalis table"
