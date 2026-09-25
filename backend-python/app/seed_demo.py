"""Minimal demo seeder (parity slice): admin + u1 (customer) + p1 (pandit) + one
puja + one seeded photo with all four artifacts, mirroring the Node seed shapes
so the auth/media tests exercise realistic rows. The full 16-puja catalogue and
18-photo seed are ported with the catalogue service."""
import shutil
import time
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .models import Pandit, Puja, PujaMedia, User
from .services.auth_helpers import hash_password
from .services.media import MEDIA_DIR, ensure_variants, make_thumb

ROOT = Path(__file__).resolve().parent.parent.parent   # repo root (shared/seed-photos)


async def seed_demo(db: AsyncSession) -> None:
    if await db.get(User, "u1"):
        return  # already seeded
    now = int(time.time() * 1000)
    db.add(User(id="admin1", role="admin", name="Temple Admin",
                email="admin@daivikpuja.in", pass_hash=hash_password("admin123"),
                status="active", created_at=now))
    db.add(User(id="u1", role="customer", name="Asha Sharma", mobile="9811100001",
                email="asha@example.com", pass_hash=hash_password("demo1234"),
                pts=50, pref='{"deity":"","lang":"English","wa":true,"sms":true,"em":true}',
                joined=time.strftime("%Y-%m-%d"), created_at=now))
    db.add(User(id="up1", role="pandit", name="Pandit Ramesh", mobile="9810000001",
                email="ramesh@example.com", pass_hash=hash_password("demo1234"),
                created_at=now))
    db.add(Pandit(id="p1", user_id="up1", name="Pandit Ramesh", city="Delhi NCR",
                  exp=12, langs='["Hindi","English"]',
                  spec='["lakshmi","griha","satyanarayan","vastu","vyapar"]',
                  rating=4.9, rev=412, done=1260, pf=1.15, status="verified",
                  featured=1, mobile="9810000001"))
    # Node seed parity: more verified pandits so auto-assignment has a pool
    # (p2..p6 mirror server/seed.js names, cities and pf multipliers).
    roster = [
        ("p2", "up2", "Acharya Suresh Iyer", "Chennai", 1.2, '["rudra","navgraha","vivah","namkaran","mrityunjaya"]'),
        ("p3", "up3", "Pt. Vinod Mishra", "Lucknow", 1.0, '["satyanarayan","hanuman","durga","pitru"]'),
        ("p4", "up4", "Pt. Harish Joshi", "Jaipur", 0.95, '["ganesh","lakshmi","vyapar","saraswati"]'),
        ("p5", "up5", "Pt. Anand Bhatt", "Ahmedabad", 1.1, '["griha","vastu","kaalsarp","navgraha"]'),
        ("p6", "up6", "Pt. Dinesh Pandey", "Pune", 0.9, '["ganesh","satyanarayan","namkaran","griha"]'),
    ]
    for i, (pid, uid, name, city, pf, spec) in enumerate(roster, start=2):
        db.add(User(id=uid, role="pandit", name=name, mobile="98100000" + str(i).zfill(2),
                    created_at=now))
        db.add(Pandit(id=pid, user_id=uid, name=name, city=city, exp=10 + i,
                      langs='["Hindi","English"]', spec=spec, pf=pf,
                      status="verified", avail=1, mobile="98100000" + str(i).zfill(2)))
    if not await db.get(Puja, "satyanarayan"):
        # The full catalogue comes from seed_catalog; this fallback only runs
        # when the demo seeder is used standalone (no catalog seed).
        db.add(Puja(id="satyanarayan", name="Satyanarayan Katha", cat="gruh",
                    price=2100, deity="Vishnu", dur=120,
                    ben="Prosperity, harmony and gratitude through the Satyanarayan katha.",
                    ben_hi="सत्यनारायण भगवान की कथा और पूजा — समृद्धि, संतान और सुख के लिए पारंपरिक सेवा।"))
    await db.flush()

    # one seeded photo with provenance + thumb, variants filled by ensure_variants
    src = ROOT / "shared" / "seed-photos" / "durga.jpg"
    if src.exists():
        MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        filename = "seed-satyanarayan-" + time.strftime("%H%M%S") + ".jpg"
        shutil.copyfile(src, MEDIA_DIR / filename)
        thumb = make_thumb(filename)
        m = PujaMedia(id="pmseed1", puja_id="satyanarayan", orig_name="durga.jpg",
                      filename=filename, mime="image/jpeg", size=(MEDIA_DIR / filename).stat().st_size,
                      status="APPROVED", is_primary=1, is_published=1, created_at=now,
                      source="seeded", license="CC BY-SA 4.0 Wikimedia Commons",
                      creator="Wikimedia contributor", alt_text="Durga puja ritual with offerings",
                      category="ritual", thumb=thumb)
        db.add(m)
        await db.flush()
        await ensure_variants(db, m)
