"""Social Media CMS demo seed (additional-requirements Phase C) — the Python
twin of seedSocialLinks() in server/seed.js.

Demo content only: Facebook, Instagram and YouTube live, LinkedIn is seeded
DISABLED so a fresh install shows the enable/disable flow. Production starts
with an empty social row — the footer simply renders nothing until an admin
adds the real profiles. Guarded on an empty table so an admin's own rows are
never duplicated.
"""
import os
import time

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import SocialLink
from .util import rid

# (platform, url, active, order)
DEMO_SOCIAL_LINKS = [
    ("facebook", "https://www.facebook.com/daivikpuja", 1, 1),
    ("instagram", "https://www.instagram.com/daivikpuja", 1, 2),
    ("youtube", "https://www.youtube.com/@daivikpuja", 1, 3),
    ("linkedin", "https://www.linkedin.com/company/daivikpuja", 0, 4),
]


def _demo_enabled() -> bool:
    raw = os.environ.get("DEMO_MODE")
    if raw is None:
        raw = "false" if os.environ.get("NODE_ENV") == "production" else "true"
    return raw.lower() == "true"


async def seed_social_links(db: AsyncSession) -> None:
    if not _demo_enabled():
        return
    count = (await db.execute(select(func.count()).select_from(SocialLink))).scalar_one()
    if count:
        return
    now = int(time.time() * 1000)
    for platform, url, active, order in DEMO_SOCIAL_LINKS:
        db.add(SocialLink(id="sl" + rid(4), platform=platform, icon=platform, url=url,
                          active=active, sort_order=order, created=now))
    await db.flush()
