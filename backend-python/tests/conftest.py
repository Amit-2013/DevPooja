"""Test bootstrap: isolated SQLite DB + tmp upload dir per test session, ASGI
client via httpx (no live port), demo seeder applied, parity with the Node
test harness (tests/api.test.js conventions)."""
import os
import tempfile
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_tmp = tempfile.mkdtemp(prefix="dp-py-")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + Path(_tmp, "t.db").as_posix()
os.environ["UPLOAD_DIR"] = Path(_tmp, "uploads").as_posix()
os.environ["DEMO_MODE"] = "true"
os.environ["JWT_SECRET"] = "test-secret-0123456789abcdef0123456789"
os.environ["ENVIRONMENT"] = "test"

from app.db import Base, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.seed_demo import seed_demo  # noqa: E402
from app.db import SessionLocal  # noqa: E402


@pytest_asyncio.fixture(autouse=True)
async def _setup_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with SessionLocal() as db:
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
    r = await client.post("/api/auth/admin", json={"email": "admin@daivikpuja.in", "password": "admin123"})
    assert r.status_code == 200, r.text
    return r.json()["token"]
