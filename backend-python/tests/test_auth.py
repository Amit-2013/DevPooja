"""Auth parity tests — the Python endpoints must behave exactly like the Node
ones: same success shapes, same failure codes and messages."""
import pytest

from tests.conftest import admin_login, login

pytestmark = pytest.mark.asyncio


async def test_health(client):
    r = await client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


async def test_demo_logins_return_tokens(client):
    ct = await login(client, "customer")
    pt = await login(client, "pandit")
    assert ct and pt
    me = await client.get("/api/auth/me", headers={"Authorization": "Bearer " + ct})
    assert me.json()["role"] == "customer"
    assert me.json()["uid"] == "u1"


async def test_email_login_existing_user(client):
    r = await client.post("/api/auth/email", json={"email": "asha@example.com", "password": "demo1234"})
    assert r.status_code == 200
    body = r.json()
    assert body["role"] == "customer"
    assert body["mustChangePassword"] is False


async def test_email_login_creates_account(client):
    r = await client.post("/api/auth/email", json={"email": "new@example.com",
                                               "password": "longenough1", "name": "New Devotee"})
    assert r.status_code == 200
    assert r.json()["role"] == "customer"


async def test_email_wrong_password_401(client):
    r = await client.post("/api/auth/email", json={"email": "asha@example.com", "password": "wrongpassword"})
    assert r.status_code == 401


async def test_email_short_password_400(client):
    r = await client.post("/api/auth/email", json={"email": "x@example.com", "password": "short"})
    assert r.status_code == 400


async def test_admin_login_and_bad_credentials(client):
    assert (await admin_login(client))
    bad = await client.post("/api/auth/admin", json={"email": "admin@daivikpuja.in", "password": "nope-nope"})
    assert bad.status_code == 401


async def test_change_password_flow(client):
    tok = (await client.post("/api/auth/email", json={"email": "cp@example.com",
                                                  "password": "firstpass1", "name": "CP"})).json()["token"]
    h = {"Authorization": "Bearer " + tok}
    wrong = await client.post("/api/auth/change-password", headers=h,
                              json={"currentPassword": "notit", "newPassword": "secondpass2"})
    assert wrong.status_code == 401
    ok = await client.post("/api/auth/change-password", headers=h,
                           json={"currentPassword": "firstpass1", "newPassword": "secondpass2"})
    assert ok.status_code == 200
    relogin = await client.post("/api/auth/email", json={"email": "cp@example.com", "password": "secondpass2"})
    assert relogin.status_code == 200


async def test_lockout_after_five_failures(client):
    for _ in range(5):
        await client.post("/api/auth/email", json={"email": "asha@example.com", "password": "wrongpassword"})
    r = await client.post("/api/auth/email", json={"email": "asha@example.com", "password": "demo1234"})
    assert r.status_code == 429
    assert "locked" in r.json()["detail"].lower()


async def test_anonymous_gets_401_on_protected(client):
    r = await client.get("/api/admin/media")
    assert r.status_code == 401


async def test_customer_blocked_from_admin(client):
    tok = await login(client, "customer")
    r = await client.get("/api/admin/media", headers={"Authorization": "Bearer " + tok})
    assert r.status_code == 403
