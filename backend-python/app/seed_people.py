"""Our People seed (additional-requirements Phase B) — the Python twin of the
migration-030 category seed plus the Node demo people.

Categories are reference data: they are inserted when missing and never
overwritten, so an admin's rename or reorder always survives a restart (Node
keeps them in the migration SQL; Python creates the same nine rows here).
Demo people mirror server/seed.js's seedDemoPeople and are seeded only when
DEMO_MODE is on and the table is empty.
"""
import json
import os
import time

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import PeopleCategory, Person

# (id, name, sort_order) — same ids and order as migration 030.
PEOPLE_CATEGORIES = [
    ("founder", "Founder", 1),
    ("main-acharya", "Main Acharya", 2),
    ("acharyas", "Acharyas", 3),
    ("vedic-scholars", "Vedic Scholars", 4),
    ("jyotish-experts", "Jyotish Experts", 5),
    ("pandits", "Pandits", 6),
    ("temple-reps", "Temple Representatives", 7),
    ("advisors", "Advisors", 8),
    ("team", "Team", 9),
]

DEMO_PEOPLE = [
    {"id": "perfounder", "name": "Shri Devendra Shastri", "designation": "Founder",
     "categoryId": "founder", "city": "Delhi NCR", "country": "India", "exp": 38, "order": 1,
     "quals": "Shastri and Acharya in Jyotish, Sampurnanand Sanskrit University, Varanasi",
     "expertise": ["Vedic ritual design", "Temple restoration", "Community seva", "Pandit welfare"],
     "intro": "Founder of DaivikPuja — three decades of puja seva, temple service and building a trusted home for Sanatan traditions.",
     "bio": "Shri Devendra Shastri began his seva as a young pandit in the lanes of Kashi, performing griha pravesh and satyanarayan katha for families who had no one to guide them through the vidhi. Over three decades he conducted pujas in homes, temples and villages across twelve states, and saw the same difficulty everywhere: families who wanted to worship properly could not find a trustworthy pandit, and learned pandits could not reach the families who needed them. DaivikPuja was founded to close that gap — a platform where every ritual is performed by a verified pandit, every samagri reaches the devotee, and no family is turned away for want of guidance. He continues to review the platform's ritual standards and personally mentors young pandits joining the seva.",
     "background": "Born into a family of Kashi pandits; studied at Sampurnanand Sanskrit University and spent his early years serving temples in Varanasi and Delhi.",
     "sanatanWork": "Guides the platform's ritual standards, leads the annual Kashi pandit meet, and supports the education of children of pandits through the seva fund.",
     "socials": []},
    {"id": "peracharya", "name": "Acharya Vishwanath Giri", "designation": "Main Acharya (Head Priest)",
     "categoryId": "main-acharya", "city": "Varanasi", "country": "India", "exp": 45, "order": 1,
     "quals": "Shrotriya (traditional six-year pathshala), Acharya in Veda and Agama",
     "expertise": ["Rudrabhishek", "Shatruvidhvansan", "Vedic teaching", "Temple Agama"],
     "intro": "The platform's head priest — a Shrotriya acharya from the Kashi lineage who anchors the ceremonial standards every pandit follows.",
     "bio": "Acharya Vishwanath Giri belongs to a Shrotriya family of Kashi that has carried the Vedic recitation tradition without a break for seven generations. He completed the full six-year pathshala before his twentieth year, mastered the Rudram, the Samaveda chants and the Agama procedures of temple worship, and has since led rudrabhishek, shatruvidhvansan and mahamrityunjaya anushthans for families from every part of India and the diaspora. As the platform's Main Acharya he settles questions of vidhi, approves the ceremonial sequence of every puja offered, and is the acharya of record for large yagnas. His teaching is simple: the ritual is not a performance but a promise, and it must be completed exactly as the shastra prescribes, for the smallest griha puja and the largest havan alike.",
     "background": "Seventh-generation Kashi pandit; trained in the traditional pathshala method and in the Agama tradition of south Indian temples.",
     "sanatanWork": "Anchors the platform's ceremonial standards, conducts the annual Vishwanath anushthan, and trains acharyas and pandits who join the platform.",
     "socials": []},
    {"id": "perak1", "name": "Acharya Keshav Shukla", "designation": "Acharya — Rudra and Havan",
     "categoryId": "acharyas", "city": "Varanasi", "country": "India", "exp": 26, "order": 1,
     "expertise": ["Rudrabhishek", "Havan vidhi", "Graha shanti"],
     "intro": "Rudra and havan acharya known for precise anushthans and clear step-by-step guidance."},
    {"id": "perak2", "name": "Acharya Lakshmi Narayan Chaturvedi", "designation": "Acharya — Katha and Pravachan",
     "categoryId": "acharyas", "city": "Prayagraj", "country": "India", "exp": 31, "order": 2,
     "expertise": ["Satyanarayan katha", "Bhagavata katha", "Pravachan"],
     "intro": "Katha acharya whose satyanarayan and bhagavata recitations are a household tradition."},
    {"id": "pervs1", "name": "Dr. Sudha Ramanujacharya", "designation": "Vedic Scholar — Sanskrit and Agama",
     "categoryId": "vedic-scholars", "city": "Chennai", "country": "India", "exp": 29, "order": 1,
     "expertise": ["Vedic text", "Agama shastra", "Manuscript study"],
     "intro": "Scholar of Vedic and Agama texts who reviews the platform's ritual references."},
    {"id": "pervs2", "name": "Pt. Govind Bhattar", "designation": "Vedic Scholar — Temple Agama",
     "categoryId": "vedic-scholars", "city": "Tiruchirappalli", "country": "India", "exp": 33, "order": 2,
     "expertise": ["Vaishnava Agama", "Temple seva", "Kumbhabhishekam"],
     "intro": "Temple Agama scholar from the Bhattar lineage who guides the platform's temple seva procedures."},
    {"id": "perjy1", "name": "Jyotish Acharya Rameshwar Tiwari", "designation": "Jyotish Expert — Shastra Jyotish",
     "categoryId": "jyotish-experts", "city": "Jaipur", "country": "India", "exp": 27, "order": 1,
     "expertise": ["Kundali analysis", "Muhurat", "Parashari system"],
     "intro": "Parashari jyotish acharya who reviews kundali analyses and muhurat guidance."},
    {"id": "perjy2", "name": "Dr. Meenakshi Narayanan", "designation": "Jyotish Expert — Nadi and Jaimini",
     "categoryId": "jyotish-experts", "city": "Chennai", "country": "India", "exp": 22, "order": 2,
     "expertise": ["Jaimini sutras", "Nadi reading", "Astronomy"],
     "intro": "Combines classical Jyotish with astronomy training for careful, evidence-led readings."},
    {"id": "perpd1", "name": "Pt. Devdatt Pandey", "designation": "Senior Pandit — Kashi Vidvat",
     "categoryId": "pandits", "city": "Varanasi", "country": "India", "exp": 24, "order": 1,
     "expertise": ["Griha pravesh", "Vivah", "Pitru seva"],
     "intro": "Kashi Vidvat pandit for life-event ceremonies across the traditional vidhi."},
    {"id": "perpd2", "name": "Pt. Aniruddh Joshi", "designation": "Pandit — Griha and Vyapar pujas",
     "categoryId": "pandits", "city": "Pune", "country": "India", "exp": 17, "order": 2,
     "expertise": ["Vastu shanti", "Vyapar puja", "Ganesh puja"],
     "intro": "Pune pandit for home, shop and office ceremonies, in Marathi and Hindi."},
    {"id": "perpd3", "name": "Pt. Suryakant Pawar", "designation": "Pandit — Marathi and Kannada rituals",
     "categoryId": "pandits", "city": "Nashik", "country": "India", "exp": 14, "order": 3,
     "expertise": ["Satyanarayan katha", "Navgraha shanti", "Namkaran"],
     "intro": "Multilingual pandit serving families across Maharashtra and Karnataka."},
    {"id": "pertr1", "name": "Shri Raghunath Iyer", "designation": "Temple Representative — Tamil Nadu",
     "categoryId": "temple-reps", "city": "Madurai", "country": "India", "exp": 20, "order": 1,
     "expertise": ["Temple seva", "Prasad dispatch", "Local coordination"],
     "intro": "Coordinates temple seva and prasad dispatch with partner temples in Tamil Nadu."},
    {"id": "pertr2", "name": "Smt. Kamala Devi", "designation": "Temple Representative — Kashi",
     "categoryId": "temple-reps", "city": "Varanasi", "country": "India", "exp": 16, "order": 2,
     "expertise": ["Temple seva", "Annadanam", "Devotee support"],
     "intro": "Coordinates devotee support and annadanam at the platform's Kashi partner temples."},
    {"id": "perad1", "name": "Dr. Vikram Aditya Deshmukh", "designation": "Advisor — Vedic Education",
     "categoryId": "advisors", "city": "Nagpur", "country": "India", "exp": 28, "order": 1,
     "expertise": ["Vedic education", "Gurukul policy", "Youth programmes"],
     "intro": "Advisor on Vedic education and youth gurukul programmes."},
    {"id": "perad2", "name": "Ms. Shruti Raghavan", "designation": "Advisor — Dharma and Legal",
     "categoryId": "advisors", "city": "Bengaluru", "country": "India", "exp": 19, "order": 2,
     "expertise": ["Trust governance", "Temple law", "Ethics review"],
     "intro": "Legal advisor for trust governance and ethics review."},
    {"id": "perteam1", "name": "Shri Aditya Kulkarni", "designation": "Team — Operations",
     "categoryId": "team", "city": "Pune", "country": "India", "exp": 12, "order": 1,
     "expertise": ["Booking operations", "Pandit network", "Quality"],
     "intro": "Runs day-to-day booking operations and the pandit network."},
    {"id": "perteam2", "name": "Smt. Bhavna Mishra", "designation": "Team — Customer Seva",
     "categoryId": "team", "city": "Lucknow", "country": "India", "exp": 9, "order": 2,
     "expertise": ["Devotee support", "Multilingual help", "Escalations"],
     "intro": "Leads devotee support in Hindi and English across every channel."},
    {"id": "perteam3", "name": "Shri Naveen Chauhan", "designation": "Team — Technology",
     "categoryId": "team", "city": "Delhi NCR", "country": "India", "exp": 11, "order": 3,
     "expertise": ["Platform engineering", "Payments", "Data"],
     "intro": "Builds and runs the platform that connects devotees, pandits and temples."},
]


def _demo_enabled() -> bool:
    raw = os.environ.get("DEMO_MODE")
    if raw is None:
        raw = "false" if os.environ.get("NODE_ENV") == "production" else "true"
    return raw.lower() == "true"


async def seed_people_categories(db: AsyncSession) -> None:
    """Insert any missing reference category; never touch an existing row."""
    for cid, name, order in PEOPLE_CATEGORIES:
        if not await db.get(PeopleCategory, cid):
            db.add(PeopleCategory(id=cid, name=name, sort_order=order, active=1,
                                  created=int(time.time() * 1000)))
    await db.flush()


async def seed_demo_people(db: AsyncSession) -> None:
    """The Node seedDemoPeople twin: skipped when any person already exists."""
    count = (await db.execute(select(func.count()).select_from(Person))).scalar_one()
    if count:
        return
    now = int(time.time() * 1000)
    for p in DEMO_PEOPLE:
        db.add(Person(
            id=p["id"], name=p["name"], designation=p.get("designation", ""),
            category_id=p["categoryId"], city=p.get("city", ""), country=p.get("country", ""),
            experience=p.get("exp", 0), qualifications=p.get("quals", ""),
            expertise=json.dumps(p.get("expertise", [])), intro=p.get("intro", ""),
            bio=p.get("bio", ""), background=p.get("background", ""),
            sanatan_work=p.get("sanatanWork", ""), video_url=p.get("video", ""),
            socials=json.dumps(p.get("socials", [])), sort_order=p.get("order", 0),
            active=1, created=now, updated=now))
    await db.flush()


async def seed_people(db: AsyncSession) -> None:
    await seed_people_categories(db)
    if _demo_enabled():
        await seed_demo_people(db)
