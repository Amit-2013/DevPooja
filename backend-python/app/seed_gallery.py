"""Photo + Video Gallery seed (additional-requirements Phase D) — the Python
twin of server/seed.js's seedDemoGallery.

Demo content only (DEMO_MODE): three albums, photos that are COPIES of the
bundled, freely-licensed images in shared/seed-photos with their full
attribution carried over (license, credit, credit url), and two devotional
YouTube videos. Guarded on an empty gallery so an admin's own rows are never
duplicated; the demo RESET wipes gallery rows, so the next boot rebuilds them.

Variants (320px JPEG thumb + WebP pair) are generated inline with Pillow —
unlike Node's sharp pass, this runs synchronously in the seeder itself.
"""
import json
import os
import shutil
import time
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import GalleryAlbum, GalleryPhoto, GalleryVideo
from .services.gallery import MEDIA_DIR, _variants
from .util import rid

ROOT = Path(__file__).resolve().parent.parent.parent   # repo root (shared/seed-photos)

# (id, name, description, sort_order) — same ids and order as server/seed.js.
ALBUMS = [
    ("gal-festival", "Festival seva",
     "Pujas performed for the major festivals — the same vidhi, in homes and temples.", 1),
    ("gal-temple", "Temple visits",
     "Temple pujas and seva at our partner temples across India.", 2),
    ("gal-behind", "Behind the scenes",
     "Samagri packing, preparation and the seva team at work.", 3),
]

# (pujaId, albumId) — a curated spread over the three albums.
PHOTOS = [
    ("ganesh", "gal-festival"), ("lakshmi", "gal-festival"), ("vivah", "gal-festival"),
    ("satyanarayan", "gal-temple"), ("rudra", "gal-temple"),
    ("havan", "gal-behind"), ("griha", "gal-behind"),
]

VIDEOS = [
    ("galv1", "Hanuman Chalisa — Shankar Mahadevan",
     "A sing-along Hanuman Chalisa from the platform's bhajan library.",
     "https://www.youtube.com/watch?v=jTNu-R9KA-4", "gal-festival", 1),
    ("galv2", "Om Jai Jagdish Hare — Aarti",
     "The evening aarti played at every platform temple seva.",
     "https://www.youtube.com/watch?v=3ucCEjXS9n8", "gal-temple", 2),
]


def _demo_enabled() -> bool:
    raw = os.environ.get("DEMO_MODE")
    if raw is None:
        raw = "false" if os.environ.get("NODE_ENV") == "production" else "true"
    return raw.lower() == "true"


def _clean_title(t: str) -> str:
    s = str(t or "").strip()
    if s.startswith("File:"):
        s = s[5:]
    if "." in s and s.rsplit(".", 1)[-1].lower() in ("jpg", "jpeg", "png", "webp", "gif"):
        s = s[: s.rfind(".")]
    return s.replace("_", " ").strip()


def _credits() -> dict:
    try:
        return json.loads((ROOT / "shared" / "seed-photos" / "credits.json")
                          .read_text(encoding="utf-8")).get("photos", {})
    except (OSError, ValueError):
        return {}


async def seed_gallery(db: AsyncSession) -> None:
    """Skipped entirely outside DEMO_MODE and whenever any album exists."""
    if not _demo_enabled():
        return
    count = (await db.execute(select(func.count()).select_from(GalleryAlbum))).scalar_one()
    if count:
        return
    now = int(time.time() * 1000)
    credits = _credits()
    for aid, name, description, order in ALBUMS:
        db.add(GalleryAlbum(id=aid, name=name, description=description, sort_order=order,
                            active=1, created=now, updated=now))
    await db.flush()

    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    order = 1
    for puja_id, album_id in PHOTOS:
        src = ROOT / "shared" / "seed-photos" / f"{puja_id}.jpg"
        if not src.exists():
            continue
        meta = credits.get(puja_id, {})
        # Deterministic name (gal-<puja>.jpg): a fresh test DB reuses the file
        # and its variants instead of regenerating them on every test, and one
        # demo photo maps to exactly one stored artifact set.
        filename = f"gal-{puja_id}.jpg"
        target = MEDIA_DIR / filename
        if not target.exists():
            shutil.copyfile(src, target)
        vt = _variants(filename)   # Pillow: thumb + WebP pair, idempotent
        title = _clean_title(meta.get("title")) or f"{puja_id} puja"
        db.add(GalleryPhoto(
            id="gp" + rid(5), album_id=album_id, filename=filename,
            thumb=vt["thumb"] or None, webp=vt["webp"] or None,
            thumb_webp=vt["thumb_webp"] or None,
            caption=title, alt_text=title,
            license=meta.get("license") or "See shared/seed-photos/CREDITS.md",
            credit=meta.get("attribution") or meta.get("credit") or "",
            credit_url=meta.get("creditUrl") or "",
            sort_order=order, active=1, created=now, updated=now))
        order += 1
    for vid, title, description, url, album_id, vorder in VIDEOS:
        db.add(GalleryVideo(id=vid, album_id=album_id, title=title, description=description,
                            url=url, sort_order=vorder, active=1, created=now, updated=now))
    await db.flush()
