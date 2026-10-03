"""Demo NRI package catalogue (Phase E follow-up) — the Python twin of
seedDemoNriPackages() in server/seed.js.

Demo content only: three diaspora packages in different currencies so the
public NRI page shows a real catalogue out of the box; production starts with
an empty catalogue and an admin adds the real packages. Guarded on an empty
table so an admin's own rows are never duplicated.
"""
import json
import os
import time

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import NriPackage

# (id, name, descr, price, currency, inr_equiv, includes)
DEMO_NRI_PACKAGES = [
    ("nrp-demo1", "Satyanarayan Katha from abroad",
     "A complete Satyanarayan katha performed for your family back home, with the "
     "sankalp taken in your family name and gotra.",
     199, "USD", 16600,
     ["Full katha by a verified pandit", "Sankalp in your family name and gotra",
      "Photos and video dispatch to you abroad", "Prasad delivered to your family in India"]),
    ("nrp-demo2", "Griha Pravesh (house warming) seva",
     "The full griha pravesh vidhi at your family new address in India, wherever in "
     "the world you are living.",
     249, "USD", 20800,
     ["Griha pravesh puja at the address in India", "Vastu shanti steps included",
      "Photos and video dispatch", "Prasad shipped to your family"]),
    ("nrp-demo3", "Diwali Lakshmi Puja - festival seva",
     "Lakshmi-Ganesh puja on Diwali evening in your family name, for prosperity in "
     "the year ahead.",
     149, "GBP", 17200,
     ["Diwali evening Lakshmi-Ganesh puja", "Sankalp with your family names",
      "Photos and video dispatch", "Prasad delivered in India"]),
]


def _demo_enabled() -> bool:
    raw = os.environ.get("DEMO_MODE")
    if raw is None:
        raw = "false" if os.environ.get("NODE_ENV") == "production" else "true"
    return raw.lower() == "true"


async def seed_nri_packages(db: AsyncSession) -> None:
    if not _demo_enabled():
        return
    count = (await db.execute(select(func.count()).select_from(NriPackage))).scalar_one()
    if count:
        return
    now = int(time.time() * 1000)
    for pid, name, descr, price, currency, inr_equiv, includes in DEMO_NRI_PACKAGES:
        db.add(NriPackage(id=pid, name=name, descr=descr, price=price, currency=currency,
                          inr_equiv=inr_equiv, includes=json.dumps(includes), active=1,
                          created=now))
    await db.flush()
