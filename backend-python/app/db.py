"""Database engine/session. SQLAlchemy async engine over either SQLite (local dev,
tests) or Supabase Postgres (production) — the URL is the only difference.

Supabase pooling note: use the pooler endpoint (port 6543, pgBouncer transaction
mode) for serverless-style scaling; for long-lived services the direct port 5432
also works. `statement_cache_size=0` is required with pgBouncer transaction mode."""
import os
import re
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


def _sql_literal(v) -> str:
    """A SQL constant for a python default value (ADD COLUMN needs one)."""
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def _type_zero(col) -> str:
    """Last-resort default for a NOT NULL column whose model has no python
    default: SQLite refuses `ADD COLUMN ... NOT NULL` without a DEFAULT."""
    from sqlalchemy import BigInteger, Boolean, Date, DateTime, Float, Integer, Numeric, String, Time

    t = col.type
    if isinstance(t, (Integer, BigInteger, Boolean)):
        return "0"
    if isinstance(t, (Float, Numeric)):
        return "0"
    if isinstance(t, (String, Date, DateTime, Time)):
        return "''"
    return "''"  # Text / JSON / unknown -> empty string is the safe readable zero


async def reconcile_columns(target=None) -> list[str]:
    """Boot-time schema self-heal: add columns the models gained AFTER this
    database was created.

    `Base.metadata.create_all` only CREATEs missing tables — it never ALTERs
    existing ones — so a dev database written by an older checkout crashed the
    boot outright (the real failure this exists for: `no such column:
    users.account_type` → "Application startup failed", after which nothing
    served). Python has no migration runner (Node's migrate.js / *.sql is the
    twin mechanism), so the lifespan calls this right after create_all.

    Additive only: nothing is dropped, renamed or rewritten, and a conformant
    database is a fast no-op. NOT NULL columns are added with a literal DEFAULT
    (the model's python default when it has one, else a type zero) because
    SQLite refuses a NOT NULL ADD without one — existing rows then read a
    usable value instead of NULL, and raw inserts that omit the column still
    satisfy the constraint. Returns the healed `table.column` names."""
    from sqlalchemy import inspect as sa_inspect, text

    eng = target or engine

    def _heal(conn) -> list[str]:
        insp = sa_inspect(conn)
        added: list[str] = []
        for tname, table in Base.metadata.tables.items():
            if not insp.has_table(tname):  # create_all runs first; stay defensive
                continue
            have = {c["name"] for c in insp.get_columns(tname)}
            for col in table.columns:
                if col.name in have:
                    continue
                if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", tname) or not re.fullmatch(
                        r"[A-Za-z_][A-Za-z0-9_]*", col.name):
                    raise RuntimeError(f"refusing to heal odd identifier {tname}.{col.name}")
                type_sql = col.type.compile(dialect=conn.dialect)
                ddl = f"ALTER TABLE {tname} ADD COLUMN {col.name} {type_sql}"
                if not col.nullable:
                    if col.default is not None and getattr(col.default, "is_scalar", False):
                        ddl += " DEFAULT " + _sql_literal(col.default.arg)
                    else:
                        ddl += " DEFAULT " + _type_zero(col)
                    ddl += " NOT NULL"
                conn.execute(text(ddl))
                added.append(f"{tname}.{col.name}")
        return added

    async with eng.begin() as conn:
        return await conn.run_sync(_heal)


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
