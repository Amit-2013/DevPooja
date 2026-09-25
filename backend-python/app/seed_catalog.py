"""Catalog seeder — port of the catalog half of server/seed.js: the full 20-puja
catalogue from data/catalog.json, kits with stock, prasad, temples, festivals,
coupons, commission setting, and the unique partial index that enforces the
pandit slot rule. The demo accounts/booking seeder remains separate."""
import json
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Banner, Coupon, Festival, Kit, Prasad, Puja, Setting, Temple

CATALOG = Path(__file__).resolve().parents[2] / "server" / "data" / "catalog.json"
STOCK = {"k_basic": 60, "k_lakshmi": 14, "k_satya": 35, "k_griha": 9, "k_shiv": 28,
         "k_havan": 40, "k_nav": 22, "k_pitru": 31, "k_ganesh": 25}
COUPONS = [["DAIVIKPOOJA10", "pct", 10, 500, 1500],
           ["FIRST100", "flat", 100, 100, 1000],
           ["FESTIVE15", "pct", 15, 750, 3000]]


async def seed_catalog(db: AsyncSession) -> None:
    """Idempotent: skips when the catalogue already exists (Node parity)."""
    from sqlalchemy import func, select
    if (await db.execute(select(func.count()).select_from(Puja))).scalar_one():
        return
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    for k in catalog["kits"]:
        db.add(Kit(id=k["id"], name=k["name"], price=k["price"], icon=k.get("icon"),
                   items=json.dumps(k.get("items", [])), stock=STOCK.get(k["id"], 20)))
    for p in catalog["pujas"]:
        db.add(Puja(id=p["id"], name=p["name"], hindi=p.get("hindi"), cat=p.get("cat"),
                    icon=p.get("icon"), dur=p.get("dur"), price=p["price"], deity=p.get("deity"),
                    ben=p.get("ben"), kit=p.get("kit"), pop=p.get("pop", 0), tags=p.get("tags", "")))
    for k in catalog["prasad"]:
        db.add(Prasad(id=k["id"], name=k["name"], price=k["price"], icon=k.get("icon"),
                      descr=k.get("descr")))
    for t in catalog["temples"]:
        db.add(Temple(id=t["id"], name=t["name"], city=t.get("city"), deity=t.get("deity"),
                      icon=t.get("icon"), pujas=json.dumps(t.get("pujas", [])),
                      offering=t.get("offering"), descr=t.get("descr")))
    for f in catalog["festivals"]:
        db.add(Festival(id=f["id"], name=f["name"], date=f.get("date"),
                        pujas=json.dumps(f.get("pujas", [])), note=f.get("note")))
    db.add(Setting(key="commission", value=json.dumps(20)))
    for c in COUPONS:
        db.add(Coupon(code=c[0], type=c[1], val=c[2], max=c[3], min=c[4], active=1, used=0))
    db.add(Banner(id="b1", text="Diwali Lakshmi Puja: book early", enabled=1))
    await db.flush()
    # Unique partial index: one live booking per (pandit, date, slot) — Node parity
    # (idx_pandit_slot ... WHERE pandit_id IS NOT NULL AND status != 'Cancelled').
    await db.execute(text("""CREATE UNIQUE INDEX IF NOT EXISTS idx_pandit_slot
        ON bookings(pandit_id, date, slot)
        WHERE pandit_id IS NOT NULL AND status NOT IN ('Cancelled')"""))
    await db.execute(text("""CREATE INDEX IF NOT EXISTS idx_bookings_user
        ON bookings(user_id)"""))
    await db.execute(text("""CREATE INDEX IF NOT EXISTS idx_bookings_pandit
        ON bookings(pandit_id)"""))
