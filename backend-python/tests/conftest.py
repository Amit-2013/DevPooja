"""Test bootstrap: isolated SQLite DB + tmp upload dir per test session, ASGI
client via httpx (no live port), catalog + demo seeders applied, parity with the
Node test harness (tests/api.test.js conventions)."""
import os
import tempfile
import time
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

_tmp = tempfile.mkdtemp(prefix="dp-py-")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + Path(_tmp, "t.db").as_posix()
os.environ["UPLOAD_DIR"] = Path(_tmp, "uploads").as_posix()
os.environ["DEMO_MODE"] = "true"
os.environ["JWT_SECRET"] = "test-secret-0123456789abcdef0123456789"
os.environ["ENVIRONMENT"] = "test"

from app.db import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.seed_catalog import seed_catalog  # noqa: E402
from app.seed_demo import seed_demo  # noqa: E402


def day_plus(n: int) -> str:
    """Same helper as tests/api.test.js: noon-anchored dates stay stable."""
    d = time.localtime(time.time() + n * 86400)
    return time.strftime("%Y-%m-%d", d)


@pytest_asyncio.fixture(autouse=True)
async def _setup_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with SessionLocal() as db:
        await seed_catalog(db)
        await seed_demo(db)
        await db.commit()
    yield
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest_asyncio.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        yield c


@pytest_asyncio.fixture
async def db_session():
    async with SessionLocal() as db:
        yield db


async def login(client: AsyncClient, role: str) -> str:
    r = await client.post("/api/auth/demo", json={"role": role})
    assert r.status_code == 200, r.text
    return r.json()["token"]


async def admin_login(client: AsyncClient) -> str:
    r = await client.post("/api/auth/admin", json={"email": "admin@daivikpuja.in",
                                                   "password": "admin123"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


async def otp_login(client: AsyncClient, mobile: str, name: str = "") -> str:
    """Node parity: POST /auth/otp/send then /auth/otp/verify (demo code 123456)
    creates/loads a customer and returns a token."""
    s = await client.post("/api/auth/otp/send", json={"mobile": mobile})
    assert s.status_code == 200, s.text
    v = await client.post("/api/auth/otp/verify", json={"mobile": mobile, "otp": "123456",
                                                        "name": name or "Test Devotee"})
    assert v.status_code == 200, v.text
    return v.json()["token"]


otp_login.day_plus = staticmethod(day_plus)  # type: ignore[attr-defined]
