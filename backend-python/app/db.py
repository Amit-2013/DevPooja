"""Database engine/session. SQLAlchemy async engine over either SQLite (local dev,
tests) or Supabase Postgres (production) — the URL is the only difference.

Supabase pooling note: use the pooler endpoint (port 6543, pgBouncer transaction
mode) for serverless-style scaling; for long-lived services the direct port 5432
also works. `statement_cache_size=0` is required with pgBouncer transaction mode."""
import os
from pathlib import Path

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import get_settings


class Base(DeclarativeBase):
    pass


_settings = get_settings()
if _settings.database_url.startswith("sqlite"):
    Path(_settings.database_url.split("///", 1)[1]).parent.mkdir(parents=True, exist_ok=True)

if _settings.database_url.startswith("postgresql"):
    # pgBouncer (Supabase pooler) does not support prepared-statement caching
    engine = create_async_engine(_settings.database_url, pool_pre_ping=True, connect_args={"statement_cache_size": 0})
else:
    # SQLite (local dev/tests): NullPool keeps connections out of the pool so
    # nothing is ever reused across event loops.
    from sqlalchemy.pool import NullPool
    engine = create_async_engine(_settings.database_url, poolclass=NullPool)

SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_db():
    """FastAPI dependency: one session per request; committed on success.
    On a deliberate business error (HTTPException) writes made before the raise
    are KEPT — Node parity: failed-login counters, lockouts and login-activity
    rows must survive the error response. Unexpected errors roll back."""
    from fastapi import HTTPException
    async with SessionLocal() as session:
        try:
            yield session
            await session.commit()
        except HTTPException:
            await session.commit()
            raise
        except Exception:
            await session.rollback()
            raise
