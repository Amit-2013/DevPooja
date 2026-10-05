"""Phase 21 — Python twin of tests/rbac.test.js: sub-roles and the permission
matrix (app/permissions.py). Covers: the admin family
(admin/finance/customer_support) is the only way into /api/admin; finance gets
the money group plus finance-domain exports only; customer_support gets the
service group and never an export; platform routes and every other export stay
full-admin; POST /users/{id}/role hands out seats with reason/self/conflict/
last-active-admin guards, audited old->new, live tokens picking the change up
immediately; and /state serves the admin payload to the whole family.
FastAPI errors surface as {"detail": ...} (parity with the Node {"error": ...}).
A fresh seeded DB is per-test (conftest autouse), so every probe is self-contained."""
import pytest
from sqlalchemy import select, update

from app.models import User
from tests.conftest import admin_login, login, otp_login

pytestmark = pytest.mark.asyncio

T = "Bearer "


def h(tok: str) -> dict:
    return {"Authorization": T + tok}


async def seat(client, db, mobile: str, role: str):
    """OTP-created customer, then the role written straight to the DB (the
    handout endpoint is exercised on its own). current_auth() re-reads the role
    per request, so the fresh token acts as the seat immediately."""
    tok = await otp_login(client, mobile, "RBAC Probe")
    uid = (await db.execute(select(User.id).where(User.mobile == mobile))).scalar_one()
    if role != "customer":
        await db.execute(update(User).where(User.id == uid).values(role=role))
        await db.commit()
    return tok, uid


async def admin_uid(db) -> str:
    return (await db.execute(select(User.id).where(User.role == "admin").limit(1))).scalar_one()


async def mk_ticket(client, tok: str) -> str:
    r = await client.post("/api/tickets", json={"t": "RBAC probe: the pandit never arrived.", "b": ""},
                          headers=h(tok))
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_family_gate(client, db_session):
    anon = await client.get("/api/admin/ledger")
    assert anon.status_code == 401
    assert anon.json()["detail"] == "Please log in"

    cust = await login(client, "customer")
    blocked = await client.get("/api/admin/ledger", headers=h(cust))
    assert blocked.status_code == 403
    assert blocked.json()["detail"] == "Not allowed", "a customer is outside the admin family"
    assert (await client.get("/api/admin/export/payments.xlsx", headers=h(cust))).status_code == 403

    pandit = await login(client, "pandit")
    px = await client.get("/api/admin/export/payments.xlsx", headers=h(pandit))
    assert px.status_code == 403, "a pandit never reaches an export"

    finance, _ = await seat(client, db_session, "9811100201", "finance")
    assert (await client.get("/api/admin/ledger", headers=h(finance))).status_code == 200, "finance enters the router"


async def test_finance_money_only(client, db_session):
    finance, _ = await seat(client, db_session, "9811100202", "finance")
    tid = await mk_ticket(client, await login(client, "customer"))

    assert (await client.get("/api/admin/ledger", headers=h(finance))).status_code == 200, "ledger is money"
    sup = await client.get(f"/api/admin/tickets/{tid}", headers=h(finance))
    assert sup.status_code == 403
    assert sup.json()["detail"] == "Not allowed for your role", "support routes are closed to finance"
    assert (await client.post("/api/admin/settings", json={"k": "probe"}, headers=h(finance))).status_code == 403, "platform is admin-only"

    assert (await client.get("/api/admin/export/payments.xlsx", headers=h(finance))).status_code == 200, "its own report exports"
    no = await client.get("/api/admin/export/customers.xlsx", headers=h(finance))
    assert no.status_code == 403, "customer accounts sit outside the finance report list"
    assert no.json()["detail"] == "Not allowed for your role"


async def test_customer_support_service_only(client, db_session):
    cs, _ = await seat(client, db_session, "9811100203", "customer_support")
    tid = await mk_ticket(client, await login(client, "customer"))

    d = await client.get(f"/api/admin/tickets/{tid}", headers=h(cs))
    assert d.status_code == 200
    assert d.json()["ticket"]["st"] == "OPEN"
    tr = await client.post(f"/api/admin/tickets/{tid}/transition", json={"status": "UNDER_REVIEW"}, headers=h(cs))
    assert tr.status_code == 200, "support drives the complaint machine"
    assert tr.json()["ticket"]["st"] == "UNDER_REVIEW"

    assert (await client.get("/api/admin/ledger", headers=h(cs))).status_code == 403, "money is closed to support"
    hold = await client.post("/api/admin/payouts/PO3/hold", json={"reason": "probe"}, headers=h(cs))
    assert hold.status_code == 403
    assert (await client.get("/api/admin/export/payments.xlsx", headers=h(cs))).status_code == 403, "support never exports"
    assert (await client.post("/api/admin/settings", json={}, headers=h(cs))).status_code == 403


async def test_admin_keeps_everything(client, db_session):
    a = await admin_login(client)
    assert (await client.get("/api/admin/ledger", headers=h(a))).status_code == 200
    assert (await client.get("/api/admin/export/customers.xlsx", headers=h(a))).status_code == 200, "a non-finance report stays admin-only"
    assert (await client.get("/api/admin/audit", headers=h(a))).status_code == 200
    tid = await mk_ticket(client, await login(client, "customer"))
    assert (await client.get(f"/api/admin/tickets/{tid}", headers=h(a))).status_code == 200


async def test_seat_handout_validates(client, db_session):
    a = await admin_login(client)
    _, uid = await seat(client, db_session, "9811100204", "customer")

    no_reason = await client.post(f"/api/admin/users/{uid}/role", json={"role": "finance"}, headers=h(a))
    assert no_reason.status_code == 400
    assert no_reason.json()["detail"] == "A reason is required"

    me = await admin_uid(db_session)
    self_ = await client.post(f"/api/admin/users/{me}/role", json={"role": "customer", "reason": "probe"}, headers=h(a))
    assert self_.status_code == 400
    assert self_.json()["detail"] == "You cannot change your own role"

    bad = await client.post(f"/api/admin/users/{uid}/role", json={"role": "pandit", "reason": "probe"}, headers=h(a))
    assert bad.status_code == 400, "pandit is a portal profile, never an operations seat"


async def test_seat_handout_success_audit_live_token(client, db_session):
    a = await admin_login(client)
    tok, uid = await seat(client, db_session, "9811100205", "customer")

    grant = await client.post(f"/api/admin/users/{uid}/role",
                              json={"role": "finance", "reason": "Month-end payout duties"}, headers=h(a))
    assert grant.status_code == 200, grant.text
    assert grant.json()["user"] == {"id": uid, "role": "finance"}

    entries = (await client.get("/api/admin/audit", headers=h(a))).json()["entries"]
    ev = next((e for e in entries if e["action"] == "account.role_changed"
               and str(e["entityId"]) == str(uid) and e["newValue"] == "finance"), None)
    assert ev, "the seat change lands in the audit trail"
    assert ev["oldValue"] == "customer"
    assert ev["reason"] == "Month-end payout duties"

    assert (await client.get("/api/admin/ledger", headers=h(tok))).status_code == 200, "the same token is money-capable now"
    assert (await client.post("/api/admin/settings", json={}, headers=h(tok))).status_code == 403, "but still not platform"

    down = await client.post(f"/api/admin/users/{uid}/role",
                             json={"role": "customer", "reason": "Duties ended"}, headers=h(a))
    assert down.status_code == 200, down.text
    assert (await client.get("/api/admin/ledger", headers=h(tok))).status_code == 403, "the demotion revokes the seat on the same live token"


async def test_seat_handout_guards(client, db_session):
    a = await admin_login(client)

    _, dup = await seat(client, db_session, "9811100206", "customer")
    await db_session.execute(update(User).where(User.id == dup).values(role="finance"))
    await db_session.commit()
    conflict = await client.post(f"/api/admin/users/{dup}/role", json={"role": "finance", "reason": "probe"}, headers=h(a))
    assert conflict.status_code == 409
    assert conflict.json()["detail"] == "That user already has this role"

    # The caller cannot be an active admin for this count to reach 1 — demoting
    # the only ACTIVE admin must refuse, whoever is asking.
    _, gov = await seat(client, db_session, "9811100207", "customer")
    await db_session.execute(update(User).where(User.id == gov).values(role="admin", status="active"))
    await db_session.execute(update(User).where(User.role == "admin", User.id != gov).values(status="invited"))
    await db_session.commit()
    last = await client.post(f"/api/admin/users/{gov}/role", json={"role": "customer", "reason": "probe"}, headers=h(a))
    assert last.status_code == 409, "the only active full admin cannot be demoted"
    assert last.json()["detail"] == "At least one active admin must remain"
    await db_session.execute(update(User).where(User.role == "admin").values(status="active"))
    await db_session.commit()

    fin, _ = await seat(client, db_session, "9811100208", "finance")
    sup, _ = await seat(client, db_session, "9811100209", "customer_support")
    sub = await client.post(f"/api/admin/users/{dup}/role", json={"role": "customer", "reason": "probe"}, headers=h(fin))
    assert sub.status_code == 403, "seats are platform: full admins only"
    assert sub.json()["detail"] == "Not allowed for your role"
    sub2 = await client.post(f"/api/admin/users/{dup}/role", json={"role": "customer", "reason": "probe"}, headers=h(sup))
    assert sub2.status_code == 403


async def test_state_serves_the_family(client, db_session):
    await seat(client, db_session, "9811100210", "customer")   # a second customer row for the list
    fin, _ = await seat(client, db_session, "9811100211", "finance")
    sup, _ = await seat(client, db_session, "9811100212", "customer_support")

    for role, tok in (("finance", fin), ("customer_support", sup)):
        st = (await client.get("/api/state", headers=h(tok))).json()
        assert st["session"]["role"] == role
        assert len(st["users"]) > 1, role + " sees every customer row"
        assert "comm" in st["set"], role + " sees the admin settings block"

    mine = (await client.get("/api/state", headers=h(await login(client, "customer")))).json()
    assert mine["session"]["role"] == "customer"
    assert len(mine["users"]) == 1, "a customer sees only themselves"
    assert "comm" not in mine["set"], "the admin settings block stays out of customer state"
