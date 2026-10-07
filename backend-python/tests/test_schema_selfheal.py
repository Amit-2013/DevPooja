"""Boot-time schema self-heal (the Python counterpart of Node's migrate.js):
`create_all` only CREATEs missing tables — it never ALTERs existing ones — so a
database file written by an older checkout used to kill the Python boot
outright:

    OperationalError: no such column: users.account_type
    -> "Application startup failed", nothing served.

`app.db.reconcile_columns()` now runs in the lifespan between create_all and
the seeders. These tests rebuild that exact staleness against an isolated
database and prove: the crashing column comes back, data survives, the healed
schema matches a fresh install, raw inserts still satisfy NOT NULL, and a
conformant database is a no-op."""
import pytest
from sqlalchemy import inspect as sa_inspect, select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.db import Base, reconcile_columns
from app.models import User

pytestmark = pytest.mark.asyncio

# A users table exactly as an older SQLAlchemy checkout left it: migration-029
# columns (account_type/location) and everything after them absent — the shape
# whose first SELECT killed the boot. Pre-existing columns keep the same
# nullability create_all would have given them (SQLite's PRIMARY KEY quirk
# aside), so the fidelity test below only implicates the HEALED columns.
STALE_USERS = """
CREATE TABLE users (
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  role VARCHAR(20) NOT NULL,
  name VARCHAR(120),
  mobile VARCHAR(15)
)
"""


async def _stale_engine(tmp_path):
    eng = create_async_engine("sqlite+aiosqlite:///" + (tmp_path / "stale.db").as_posix())
    async with eng.begin() as conn:
        await conn.execute(text(STALE_USERS))
        await conn.execute(text(
            "INSERT INTO users (id, role, name, mobile) "
            "VALUES ('u_stale', 'pandit', 'Stale Devotee', '9811100999')"))
    return eng


async def test_stale_boot_self_heals_and_the_crashing_query_works(tmp_path):
    eng = await _stale_engine(tmp_path)
    try:
        # the lifespan's boot order: create_all first (fresh tables appear),
        # then the reconciliation walks the tables that already existed
        async with eng.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        added = await reconcile_columns(eng)
        assert "users.account_type" in added, "the column whose absence used to kill boot"
        assert "users.pts" in added and "users.pref" in added

        # data preserved; healed NOT NULL columns read usable values
        async with eng.connect() as conn:
            row = (await conn.execute(text(
                "SELECT id, role, name, account_type, pts FROM users WHERE id='u_stale'"
            ))).one()
            assert (row.id, row.role, row.name) == ("u_stale", "pandit", "Stale Devotee")
            assert row.account_type == "normal", "the model default fills the healed NOT NULL"
            assert row.pts == 0

        # THE round-1 crash statement, now green: the ORM selecting account_type
        async with AsyncSession(eng) as s:
            u = (await s.execute(select(User).where(User.id == "u_stale"))).scalar_one()
            assert u.account_type == "normal" and u.mobile == "9811100999"

        # a raw insert omitting every HEALED column still satisfies their
        # NOT NULL constraints (the literal DEFAULTs the reconciler attached)
        async with eng.begin() as conn:
            await conn.execute(text(
                "INSERT INTO users (id, role, name) VALUES ('u_raw', 'customer', 'Raw Devotee')"))
            raw = (await conn.execute(text(
                "SELECT account_type, pts FROM users WHERE id='u_raw'"))).one()
            assert raw.account_type == "normal" and raw.pts == 0

        # second boot: nothing left to heal (idempotent)
        assert await reconcile_columns(eng) == []
    finally:
        await eng.dispose()


async def test_healed_schema_matches_a_fresh_install(tmp_path):
    """Type and nullability of every healed column must equal what create_all
    would have produced on a fresh database (the only sanctioned deviation is
    the literal DEFAULT SQLite forces on a NOT NULL add, which is asserted as
    a working default in the test above)."""
    stale = await _stale_engine(tmp_path)
    fresh = create_async_engine("sqlite+aiosqlite:///" + (tmp_path / "fresh.db").as_posix())
    try:
        async with fresh.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with stale.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        await reconcile_columns(stale)

        async def snapshot(eng):
            async with eng.connect() as conn:
                return await conn.run_sync(
                    lambda c: {t: {x["name"]: (str(x["type"]).upper(), x["nullable"])
                                   for x in sa_inspect(c).get_columns(t)}
                               for t in ("users", "bookings")})

        fresh_cols = await snapshot(fresh)
        healed_cols = await snapshot(stale)
        for table in ("users", "bookings"):
            for name, spec in fresh_cols[table].items():
                assert healed_cols[table].get(name) == spec, f"{table}.{name} healed differently"
    finally:
        await stale.dispose()
        await fresh.dispose()


async def test_conformant_database_is_a_noop():
    """The suite's own database is complete (create_all just ran): reconcile
    must find nothing — twice, proving it never touches a healthy schema."""
    assert await reconcile_columns() == []
    assert await reconcile_columns() == []
