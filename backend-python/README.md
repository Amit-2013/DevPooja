# DaivikPooja — Python Backend (FastAPI)

Restructure of the Node/Express backend to **Python + FastAPI**, targeting
**Supabase PostgreSQL** on **Render**, tested with **pytest** (Playwright E2E
comes with the frontend-parity milestone). The vanilla-JS SPA is served
unchanged — the API contract (routes, payloads, status codes) matches the Node
server so the cutover is a Render service switch, not a frontend rewrite.

## Status — auth + media + bookings + payments

| Ported | Parity notes |
|---|---|
| JWT auth (email / OTP / admin / demo / change-password) | same claims `{uid, role, pid}`, 48h tokens, bcrypt hashes are **compatible with Node-era rows**; demo OTP fixed at 123456 like Node |
| Lockout + login accounting | 5 fails → 15 min lock; `login_activity` rows; counters survive error responses (Node parity) |
| Account status gate | suspended/disabled rejected on every request, DB re-checked per call |
| Media engine (upload → review → publish) | pandit uploads forced `PENDING_ADMIN_REVIEW` for own bookings only; alt text required; magic-byte sniffing rejects fake `.jpg` |
| **Bookings + pricing engine** | full port of `shared/pricing.js` with JS `Math.round` parity (round-half-up); server always recomputes; modes/slots/GST/points/coupons identical |
| Booking lifecycle | create (auto-assign, stock, points, coupons, Partial-Unique slot index → 409 on clash), cancel with tiered refunds (100/75/50 by >48h/24–48h/else), reschedule with availability, reviews updating pandit rating, pandit accept/reject/start/complete (payouts on completion), admin assign/status/refund/manual |
| **Razorpay payments** | mock + razorpay modes; `POST /payments/verify` (HMAC `order|pay`); **webhook** reads the RAW body, verifies HMAC-SHA256 **before JSON parsing**, 503 when unconfigured, replay-idempotent via `idempotency_keys` (`wh:<id>`), reconciles `PendingPayment` bookings; unpaid holds expire after 15 min |
| Public gallery | `APPROVED + is_published` only, primary-first, `limit/offset/nextOffset` + category filter identical |
| Moderation + bulk | approve/reject(+reason)/publish/unpublish/primary, `POST /admin/media/bulk` with per-id results |
| WebP variants | Pillow port of `mediaVariants.js`, idempotent |
| **4-artifact delete** | original + thumb + webp + thumb_webp all removed, with stale-column fallback (port of Node fix `965ce74`) |
| Secure download | role-checked; anonymous/customer get private photos as 404 |
| `/api/state` + `/api/quote` | role-scoped state builder ported from `lib/state.js` (masked pandit views, admin inventory, coupons, settings) |
| **Kundali engine** | full port of `services/astrology`: Meeus/JPL sidereal ephemeris (JPL-anchor tests to <3'), Lahiri ayanamsa, ascendant, navamsa, whole-sign houses, Vimshottari dashas, panchang (tithi/paksha/vara), dignity — all Hindi (Devanagari) fields additive, English untouched |
| **Dosh rules + recommendations** | all 9 rules (mangal, kaal sarp, pitru, nadi, grahan, guru chandal, shani/Sade Sati transit, rahu, ketu) with bilingual evidence; DB-driven condition → puja/kund/samagri recommendations with priority tiers |
| **Commercial kundali** | plan quotas (1/2/5 free personal), family-member chargeables, GST/coupon/discount quotes, `PENDING_PAYMENT → PAID` verify with mock/razorpay parity, idempotency keys, 15/15-min rate limit, guest flow, family CRUD (`/api/me/family`) |

Not ported yet: Excel reports, admin puja editing, pandit registration/KYC
uploads, campaigns/leads. The Node server keeps running until these land.

## Quickstart (local, SQLite — no config needed)

```bash
cd backend-python
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt        # Windows
.venv\Scripts\python -m pytest -q                    # 59 tests, green
.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000/api/docs for OpenAPI docs, or http://localhost:8000/
for the SPA. Boot auto-creates tables and seeds the full catalogue from
`server/data/catalog.json` (18 pujas, 9 kits, temples, festivals, coupons) plus
demo accounts and the kundali reference data (conditions, place index, kunds).
Admin: `admin@daivikpuja.in` / `admin123`.

## Switching to Supabase PostgreSQL

1. Create a project at supabase.com → *Project Settings → Database → Connection
   string → URI* (use the **pooler** URI, port 6543).
2. In `backend-python/.env` (copy from `.env.example`):

   ```
   DATABASE_URL=postgresql+asyncpg://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres
   JWT_SECRET=<python -c "import secrets; print(secrets.token_urlsafe(48))">
   RAZORPAY_WEBHOOK_SECRET=<from the Razorpay dashboard>
   DEMO_MODE=false
   ```

3. Apply schema with Alembic (recommended for managed Postgres):

   ```bash
   .venv/Scripts/python -m alembic revision --autogenerate -m "init schema"
   .venv/Scripts/python -m alembic upgrade head
   ```

No code changes — the same models run on both engines.

## One-time data migration: SQLite → Postgres

`tools/migrate_sqlite_to_postgres.py` copies the entire Node/SQLite database
into Postgres **with every id preserved** (users, bookings, payments,
kundalis, puja_media photo metadata, audit trails — all 48 tables), so the
FastAPI backend can take over production data without breaking references.

```bash
# 1. Plan only — prints the translated DDL + per-table row counts, writes nothing
cd backend-python
.venv/Scripts/python tools/migrate_sqlite_to_postgres.py --dry-run

# 2. Cutover — target is the Supabase pooler URI (Project Settings → Database)
.venv/Scripts/python tools/migrate_sqlite_to_postgres.py \
    --source ../data/daivikpooja.db \
    --target postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

What it does: WAL-checkpoints the source, introspects schema + FK graph,
translates DDL (rowid-alias `INTEGER PRIMARY KEY` → `BIGINT IDENTITY`, literal
defaults kept, sqlite-only expressions dropped, the partial unique
`idx_pandit_slot` recreated verbatim), copies rows in chunks with deterministic
type coercion (empty strings in numeric columns → NULL), recreates indexes,
resyncs identity sequences with `setval(MAX(id))`, and **verifies every table**
(row count + max id must match the source; non-zero exit otherwise).

Options: `--tables users,bookings` (subset), `--truncate` (empty target first;
otherwise non-empty targets refuse), `--dry-run`. The source file is only ever
opened read-only. The pytest suite runs the full pipeline against the real
production file as a dress rehearsal (`test_dress_rehearsal_real_database`).

## Razorpay webhook

Set the same secret in the Razorpay dashboard and the environment:
`RAZORPAY_WEBHOOK_SECRET`. The endpoint is `POST /api/webhooks/razorpay`.
Verification order matches Node exactly: raw-body HMAC → parse → idempotency
check → reconcile. Signature failures get 400, unconfigured secret 503,
handler errors 500 (so Razorpay retries).

## Layout

```
backend-python/
  app/
    config.py            settings from env (same names as Node's)
    pricing.py           shared/pricing.js port (js_round parity)
    db.py                async engine (SQLite ↔ Postgres via DATABASE_URL)
    models.py            25+ tables mirroring the SQLite schema
    security.py          JWT sign/verify + role dependencies
    serialize.py         lib/serialize.js port (short field names)
    state.py             lib/state.js port (role-scoped /api/state)
    util.py              validators, magic-byte sniffing, artifact naming
    services/
      auth_helpers.py    lockout, login activity, reset tokens
      bookings.py        the booking engine (pricing, lifecycle, payouts)
      media.py           the media engine (gallery/moderation/variants/delete)
      otp.py             OTP issue/verify (demo-code parity)
      payments.py        Razorpay adapter + signature verification
      kundali_billing.py quotas, classify, quotes, idempotency (migration 008)
      astrology/         kundali port: ephemeris, kundali_engine, dosh_engine,
                         recommendation_engine, rules/ (9 pure rule modules)
    routers/
      auth.py            /api/auth/*
      media.py           gallery, pandit + admin media
      customer.py        /api/bookings, /api/payments/verify, /api/orders ...
      kundali.py         /api/kundali/* + /api/me/family (migration 008)
      pandit.py          /api/pandit/bookings/:id/:action, availability ...
      admin.py           /api/admin/bookings, coupons, settings, kits, prasad
      payments.py        /api/webhooks/razorpay (raw-body HMAC)
    seed_catalog.py      full catalogue from server/data/catalog.json
    seed_demo.py         demo users/pandits/photo (idempotent)
    seed_kundali.py      conditions + Hindi, place index, kunds, rule mapping
  migrations/            Alembic environment
  tests/                 59 parity tests (pytest + httpx ASGI)
```

## Render deployment (when the cutover is chosen)

The repo-root **`render.yaml`** declares this service (`daivikpooja-fastapi`,
Docker runtime, free plan, health check `/api/health`). In Render:
**New + → Blueprint** → pick this repo → **Apply**. Render prompts once for
`DATABASE_URL` (and the Razorpay secrets if you want them now), generates a
random `JWT_SECRET`, and auto-syncs on every push afterwards. The existing
Node service is untouched by the blueprint; `render.yaml` carries a commented
block to adopt it too (paste its exact dashboard name — a matching name
adopts the existing service, a different one would create a duplicate).

The blueprint builds `backend-python/Dockerfile` with the **repo root as the
docker context** (`dockerContext: .`), because the app reads
`server/data/catalog.json` and serves `public/` — both outside
`backend-python/`. The multi-stage image installs pinned wheels on
`python:3.12-slim`, runs as `nobody`, keeps uploads (and the fallback SQLite
file) on a `/data` volume, and honours Render's injected `PORT`. To adopt the
service without the blueprint instead: create a Web Service with Docker
runtime, Dockerfile path `./backend-python/Dockerfile`, context `.`.
Native-Python fallback: build `pip install -r backend-python/requirements.txt`,
start `cd backend-python && uvicorn app.main:app --host 0.0.0.0 --port $PORT`.

Env vars (identical either way): `DATABASE_URL` (Supabase pooler URI — the
blueprint prompts for it; without it the service boots on throwaway SQLite),
`JWT_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `PAYMENT_MODE`,
`ENVIRONMENT=production`, `DEMO_MODE=false`.

Local image test: `docker build -f backend-python/Dockerfile -t daivikpooja-api .`
then `docker run -p 8000:8000 -e JWT_SECRET=... daivikpooja-api`.
A root `.dockerignore` keeps secrets, databases and venvs out of both image
builds (Node and Python).

## Testing

```bash
.venv/Scripts/python -m pytest -q        # 59 tests: auth, media, bookings, payments, astrology
```

Covers the ported Node blocks: quote parity against the shared pricing module,
double-booking 409s, tiered refunds, reschedule conflicts, the pandit flow with
payouts + masked mobiles, cross-role security, stock conflicts, Razorpay
hold/verify/expiry, and webhook signature + idempotency + reconciliation.

The astrology suite (`tests/test_astro_parity.py`) ports `tests/astro.test.js`
1:1: JPL Horizons longitude anchors for two instants (tolerances 0.02–0.1°),
Gandhi/Einstein sidereal ascendants, chart invariants, Vimshottari contiguity,
the mangal/grahan/nadi rule behaviours and the Hindi field contract.
`tests/test_kundali_api.py` drives the HTTP flow: guest + customer generation,
free-quota→paid transitions, family-member chargeables and saved-place override,
idempotent replays, `pay/verify` semantics, ownership 404s, places/conditions/
catalog metadata, and family CRUD validation.
