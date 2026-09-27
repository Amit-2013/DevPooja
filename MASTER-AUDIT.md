# DaivikPooja — Master Technical Audit (Phases 0–2)

Authoritative feature/status map produced before any Phase 3+ implementation, per the
master prompt's AUDIT → MAP → DEDUPLICATE rule. Statuses:
`WORKING` (exists, tested, in use) · `PARTIAL` (exists, incomplete) · `BUGGY` ·
`DUPLICATED` · `MISSING` (not implemented anywhere).

Verification baseline at audit time: Node 36/36 (30 API + 4 security + 2 KYC/lifecycle),
Python 90/90 (incl. CI-wiring guards + audit-claim guards + foundation + availability +
security + KYC/lifecycle suites), UI smoke clean. `backend-python/tests/test_audit_claims.py`
pins the inventory claims in this document to the real codebase so the two cannot
silently drift apart.

Legend — **N** = Node/Express (`server/`), **P** = FastAPI port (`backend-python/`,
Node-parity contract), **FE** = `public/js/` SPA, **DB** = SQLite schema.

---

## 0. Inventory snapshot (refreshed after the foundation/availability/security rounds)

| Layer | Count | Notes |
|---|---|---|
| N endpoints | 115 | admin 71, customer 16, pandit 13, kundali 9, auth 6 |
| P endpoints | 73 | admin 22, media 11, customer 12, pandit 9, kundali 9, auth 7, reports 2, payments 1 |
| N tables | ~57 | `server/db.js` + migrations 001–015 (012 audit/payout, 013 availability, 014 scaffolding, 015 account lifecycle) |
| P models | 47 | `app/models.py`, mirrored incl. kundali set + 014 scaffolding |
| FE | 8 JS files, ~924 LOC + `account.js` | hash router in `main.js`; portals in `portal-admin.js` |
| Reports | 28 ids | 27 + `payout-audit`; REPORTS registry + openpyxl twin (`reports.py`, `xlsx.py`) |
| Tests | Node 36 (30 API + 4 security + 2 KYC/lifecycle), Python 90 | `tests/api.test.js`, `tests/security.test.js`, `tests/kyc.test.js`, `backend-python/tests/` |

**Standing Python-parity gaps** (recorded pre-audit, re-confirmed): admin puja editing,
pandit registration/KYC uploads, campaigns/leads management, Excel admin-kundali
settings. Every Phase 3+ feature must land in both N and P or be explicitly listed as
a parity exception.

## 1. Feature/status map by master-prompt phase

### Phase 3 — Pandit availability calendar — **IMPLEMENTED (Phase 3 complete)**
| Aspect | Finding |
|---|---|
| Was | `pandits.off` per-date toggle + slot-conflict only; no weekly off, slots, holidays, blocked dates, radius or capability flags |
| Now | Migration 013 extends the SAME pandits table (weekly_off, slots, holidays, blocked_dates with reasons, radius_km + base coords, online/temple flags — all permissive defaults so existing data is untouched). ONE engine: `server/services/availability.js` + twin `backend-python/app/services/availability.py` with the ordered bookable formula (KYC → avail → weekly off → holiday → blocked → marked-off → slot → online/temple → home radius → conflict) returning WHY on every NOT BOOKABLE. Booking creation, reschedule and admin assignment all consult it; auto-assign honours radius and capabilities; `GET /pandit/calendar`, `PUT /pandit/calendar`, `POST /pandit/calendar/dates`, `GET /pandit/calendar/why` (both backends); customer `GET /pandits/available` (Node: mounted via customerPaths). Pandit portal: rules editor (weekly off, slots, flags, radius + base city) and month grid with date actions (toggle/holiday/block-with-reason). Legacy date-toggle un-blocks structured entries. DB partial unique index remains the hard double-booking guarantee. |

### Phase 4 — Pandit KYC — **IMPLEMENTED (Phase 4 complete)**
| Aspect | Finding |
|---|---|
| Was | Binary approve/reject on `pandits.kyc` JSON; no per-document records, expiry or reminders |
| Now | `kyc_documents` (014) activated: per-document upload (pandit portal Profile tab; magic-byte + PDF checks, 8 MB cap), full vocabulary PENDING/UNDER_REVIEW/VERIFIED/REJECTED/EXPIRED/REVERIFICATION_REQUIRED (+SUPERSEDED history), re-upload supersedes the open copy keeping history, admin decisions require reasons the pandit sees, expiry sweep + 30-day reminders surface in the admin KYC tab and notify the pandit, every decision audited with old→new status + reason, admin document download endpoint. `services/kyc.js` + twin `services/kyc.py`; closes the Python pandit-upload parity gap |

### Phase 5 — Pandit profile
| Aspect | Finding |
|---|---|
| Existing | `pandits` has name/city/exp/langs/spec/rating/rev/done/pf/bio/kyc/featured/off/avail; FE profile edit tab; public pandit profile page |
| Status | **PARTIAL** — missing photo, gotra/lineage, qualifications, approved-services control (spec doubles as it, unverified), QA score, cancellation/no-show % |
| Required | Extend `pandits` columns (migration) + profile tab sections; derive cancellation%/no-show% from bookings |

### Phase 6 — Service photo date gate
| Aspect | Finding |
|---|---|
| Existing | Pandit photos tab: upload against own assigned booking, admin moderation, delete-own-pending; `puja_media` + metadata (010) + variants (011); sharp pipeline |
| Status | **PARTIAL** — booking linkage exists; **no scheduled-date validation** (upload any time), no admin override concept |
| Required | Server-side gate: upload allowed only when `booking.date == today` (admin override flag + audit log entry); admin view shows upload timestamp/actor |

### Phase 7/8 — Earnings & payout engine — **FOUNDATION COMPLETE (Phase 31-adjacent, done first)**
| Aspect | Finding |
|---|---|
| Was | `payouts(id, pandit_id, amount, date, status, booking_id)`; Pending/Paid only; commission from `getSetting('commission', 20)` (settings-driven) |
| Now | `server/services/payoutEngine.js` + Python twin `services/payout_engine.py`: canonical statuses PENDING/ON_HOLD/PROCESSING/DISBURSED/FAILED/REVERSED, hold reasons + notes (pandit-visible), money trail (gross/commission/tax/refund/adjustment → net), processing/disbursement dates, payment ref + UTR, settings-driven hold rules (`payout_holds`), auto-hold for unverified-pandit payouts, transitions audited with old→new status; migration 012; finance tab lifecycle UI; pandit earnings tab shows full breakdown + WHY on hold; `payout-audit` report id in both registries |

### Phase 9 — Commission tiers
| Aspect | Finding |
|---|---|
| Existing | Single `commission` setting; `commission_tiers` TABLE ALREADY CREATED (migration 014, empty) |
| Status | **MISSING** (tiers) |
| Required | **Activate** the scaffolded table: tier/category/pct/effective-dates resolver consulted by the payout engine; admin UI in finance tab; settings default stays fallback |

### Phase 10 — Dakshina
| Aspect | Finding |
|---|---|
| Existing | `payments` table; bookings carry pay JSON; `transactions` TABLE ALREADY CREATED (migration 014, empty) |
| Status | **MISSING** (typed ledger) |
| Required | **Activate** the scaffolded `transactions` table (SERVICE_PAYMENT/DAKSHINA/REFUND/COMMISSION/PAYOUT/ADJUSTMENT) written by the payment/payout paths; pandit dashboard + admin reports show Dakshina separately (+ report id) |

### Phase 11 — Puja pricing management
| Aspect | Finding |
|---|---|
| Existing | Admin pujas tab: per-puja price edit, hide/show, add-puja form, categories, Hindi names (007); P parity gap on editing |
| Status | **PARTIAL** — price+visibility only; no per-mode (home/online/customized) pricing/duration/samagri config, no commission/pandit-share per service |
| Required | Extend pujas with mode-priced columns or a `puja_mode_pricing` table; admin form sections; P endpoint parity |

### Phase 12 — Temple management
| Aspect | Finding |
|---|---|
| Existing | `temples` table + temple_pujas; FE temple directory; admin pujas tab shows temples **read-only**; booking checks `temples.pujas` for temple-mode availability |
| Status | **PARTIAL** — add/edit/activate/photos/pandit-assignment all missing |
| Required | Extend admin (add/edit/deactivate/photos/timings/pandit assignment); reuse temples table; P parity |

### Phase 13 — NRI packages
| Aspect | Finding |
|---|---|
| Existing | Nothing |
| Status | **MISSING** |
| Required | `nri_packages` table + admin CRUD + checkout path honoring package pricing/currency (kundali billing already has currency — reuse patterns) |

### Phase 14 — Coupons
| Aspect | Finding |
|---|---|
| Existing | `coupons(code, type, val, max, min, active, used)`; validated in `priceRequest()` via `shared/pricing.couponProblem()`; admin create/toggle in finance tab |
| Status | **PARTIAL** — global scope only; no applicability (PUJA/KUNDALI/PRASAD/service targeting), no date window, no per-customer limit |
| Required | Add scope columns to existing coupons table + validation in all three checkout paths (booking, kundali, orders); admin form fields |

### Phase 15 — Kundali history
| Aspect | Finding |
|---|---|
| Existing | `kundalis` table keyed to `customer_id`, full chart/panchang/dosh/recommendations persisted; `GET /kundali/mine` + customer account view; admin kundalis report; family members linked |
| Status | **WORKING** — linkage exists; needs only richer history view (filters) if desired |
| Required | Small FE polish; no schema work |

### Phase 16 — Cancellation/rescheduling engine
| Aspect | Finding |
|---|---|
| Existing | Tiered refunds in `cancelInternal()` (100/75/50% policy enforced server-side), refund states, reschedule in booking log, expire-unpaid sweep |
| Status | **PARTIAL** — customer-side only; no pandit-cancel/no-show compensation, penalties not configurable (rules are in code, not settings) |
| Required | Extract cancellation engine service; move windows/percentages to settings; add pandit-cancel + no-show paths with compensation; N+P |

### Phase 17 — QA & rating engine
| Aspect | Finding |
|---|---|
| Existing | `reviews` table (rating-only-from-completed), moderation (hide/show), rating aggregates on pandits, pandit growth tab shows acceptance/completion rates |
| Status | **PARTIAL** — no punctuality/compliance/communication breakdown, no QA score, no admin QA history |
| Required | Extend reviews or add `qa_records`; QA score computation; admin history view |

### Phase 18 — Trial pooja
| Aspect | Finding |
|---|---|
| Existing | No application code; `trial_poojas` TABLE ALREADY CREATED (migration 014, empty) |
| Status | **MISSING** |
| Required | **Activate** the scaffolded table + admin form + result vocab (PENDING/PASSED/FAILED/REASSESSMENT_REQUIRED); gate activation flow |

### Phase 19 — Complaints
| Aspect | Finding |
|---|---|
| Existing | `tickets` + `ticket_messages` + `login_activity`; customer submit from booking; admin resolve button |
| Status | **PARTIAL** — Open/Resolved only; master workflow OPEN→UNDER_REVIEW→PANDIT_RESPONSE→CUSTOMER_RESPONSE→DECISION→RESOLVED not implemented; no evidence attachments |
| Required | Extend tickets status vocab + admin workflow controls + attachments (reuse media upload path) |

### Phase 20 — Incident reporting
| Aspect | Finding |
|---|---|
| Existing | No application code; `incidents` TABLE ALREADY CREATED (migration 014, empty) |
| Status | **MISSING** |
| Required | **Activate** the scaffolded table (categories as specified) + pandit "Report incident" + admin triage; link to booking/customer |

### Phase 21 — RBAC
| Aspect | Finding |
|---|---|
| Existing | Roles: admin/customer/pandit via JWT; admin-only exports audit-logged; pandit portal shows masked mobiles; no FINANCE/CUSTOMER_SUPPORT/SUPER_ADMIN, no permission matrix |
| Status | **PARTIAL** |
| Required | Extend users role vocab + permission map (pandit must never export); permission checks in admin routes by sub-role |

### Phase 22 — Pandit account status — **IMPLEMENTED (Phase 22 complete)**
| Aspect | Finding |
|---|---|
| Was | Login-level suspension only (009); no lifecycle with reasons/dates/payout linkage |
| Now | Migration 015 adds account_reason/_from/_to/_review_date/_note to pandits. `services/accountStatus.js` + twin: ACTIVE/UNDER_REVIEW/SUSPENDED/TERMINATED (ACTIVE == 'verified'; onboarding states untouched). Suspension/termination block login immediately (existing tokens revoked by the 009 re-check), block booking via the availability engine (ACCOUNT code with the reason), and HOLD open payouts (Admin Hold + documented reason; legacy 'Pending' rows included). Termination is final (no reinstatement). Reinstatement clears the columns and releases held payouts to PROCESSING. Every transition audited old→new lifecycle + reason. Admin pandits tab shows lifecycle badges + Suspend/Reinstate/Terminate actions |

### Phases 23–25 — Agreements
| Aspect | Finding |
|---|---|
| Existing | No application code; `agreements` + `agreement_acceptances` TABLES ALREADY CREATED (migration 014, empty; unique index version-locks acceptance) |
| Status | **MISSING** |
| Required | **Activate** the scaffolded tables (versions, publish/archive, document hash, manual upload) + acceptance flow (OTP/IP/device/audit) + admin screens; never overwrite accepted versions |

### Phase 26 — Leads
| Aspect | Finding |
|---|---|
| Existing | `leads(id, type, name, details, date)` minimal; captured from enquiries; admin support tab lists; leads report exists |
| Status | **PARTIAL** |
| Required | Extend columns (mobile/email/source/interested service/location/assigned employee/status/follow-up/notes/conversion/booking_id) + filter/export |

### Phases 27–29 — Communication / campaigns / notifications
| Aspect | Finding |
|---|---|
| Existing | `notify.js` in-app notifications + `notifs` table; `campaigns(id,name,channel,audience,status,sent)` minimal; admin marketing tab: create campaign, push broadcast, banners |
| Status | **PARTIAL** — WhatsApp/SMS/Email are labels only (no senders); campaigns have no lifecycle (DRAFT…COMPLETED); no Excel-upload source |
| Required | One notification engine service (channel adapters, provider-gated); campaign lifecycle state machine; Excel import with validation/dedupe preview mapping to existing customers/leads |

### Phase 30 — Reports
| Aspect | Finding |
|---|---|
| Existing | 27 report ids, Exceljs/openpyxl twin implementations, export audit log, filters |
| Status | **WORKING** — extend registry for new modules (KYC, incidents, agreements, transactions/Dakshina, commission tiers, NRI packages) |

### Phase 31 — Audit log — **FOUNDATION COMPLETE (done first)**
| Aspect | Finding |
|---|---|
| Was | `audit_logs` + admin audit tab; all exports and sensitive account actions logged; no old/new value, reason, IP, device |
| Now | Migration 012 adds old_value/new_value/reason/ip/device (both backends); central helpers (`lib/audit.js` / AuditLog writes) persist them; commission + coupon + KYC + account-status + payout actions write old→new values and reasons; `GET /admin/audit` returns the enriched shape (new Python endpoint — closes a parity gap); FE audit tab displays reason |

### Phase 32 — Dashboard
| Aspect | Finding |
|---|---|
| Existing | Admin dashboard KPIs (bookings, gross, commission, active pandits, KYC pending, unassigned, tickets, refunds) |
| Status | **PARTIAL** — add pending agreements, today's pujas/revenue, payout pending/on-hold, incidents, campaigns, leads, kundalis-generated |

### Phases 33–37 — Validation, security, dedup, regression, quality
- **Phase 34 security harness IN PLACE (landed early with migration 014):**
  `tests/security.test.js` (Node, 4 tests) + `backend-python/tests/test_security.py` (3 tests)
  — pandit/customer cannot reach exports or admin reads (403/401 asserted per path),
  cross-role isolation (cancel/accept/audit-trail ownership), duplicate booking
  (DB constraint), duplicate payment (Razorpay signature replay is idempotent),
  duplicate payout disbursement (engine refuses transitions out of DISBURSED),
  kundali idempotency-key replay, and malformed/injection-shaped input handling.
  Later phases must keep these green; new endpoints inherit the guards.
- **Migration 014 scaffolding created (empty, unused until each phase lands):**
  kyc_documents [4], commission_tiers [9], transactions [10], incidents [20],
  agreements + agreement_acceptances (version-locked unique index) [23-25],
  trial_poojas [18] — SQLAlchemy models mirrored.
- E2E workflows to script-test: onboarding, booking (with availability), customized puja, KYC, agreement, payout.
- Duplication sweep after implementation; no dead code/placeholder buttons (FE note: analytics "Sample" KPI and incentives text are static copy — verify and either wire or label).

### Phase 36 — Do-not-break list
Demo accounts (`u1`, `p1`, admin env creds, OTP 123456 demo mode), demo reset, mock
bookings, kundali free-quota model, existing 27 reports, media pipeline, both test
suites — all must stay green after every phase.

## 2. Duplication map (Phase 1) — known forks to keep single-source

| Function | Single source | Duplication risk to avoid |
|---|---|---|
| Pricing/quote | `shared/pricing.js` | Never re-derive commission/discount in services |
| Commission | `getSetting('commission')` → payout engine | Do not introduce a second constant |
| Availability | `services/availability.js` + Python twin `services/availability.py` | All bookable checks go INSIDE the engine; `is_free`/`auto_pick` are thin delegates |
| Payout math/statuses | `services/payoutEngine.js` + Python twin | No inline commission math, no direct payouts UPDATE outside transitions |
| Refunds | `cancelInternal()` | No parallel refund writer |
| Excel export | REPORTS registry + xlsx port | New reports added to BOTH registries, not ad-hoc |
| Notifications | `notify.js` | No per-module notification logic |
| Audit | `lib/audit.js` helper (N) / AuditLog writes (P) | No direct audit_logs INSERTs scattered; enriched fields via the helpers |

## 3. Migration safety (Phase 2)

Migrations 001–014 exist and are idempotent-ordered (012 audit/payout, 013
availability, 014 scaffolding tables). Baseline rules going forward:
1. Every new column/table checked against the inventory above first (`IF NOT EXISTS`).
2. No destructive changes to users/pandits/bookings/payments/kundalis/coupons data.
3. SQLite migration + mirrored SQLAlchemy models in the same commit; both test suites
   seeded/verified after each migration.
4. Extension-first, as demonstrated: 013 added availability COLUMNS to `pandits`
   rather than a parallel availability table (the once-planned `pandit_availability`
   table is superseded by that decision). Remaining genuinely-new entities:
   `nri_packages` [13] and possibly `qa_records` [17]; everything else already has a
   scaffolded table from 014 or extends existing columns.

## 4. Build order (confirmed — dependency-driven, always Node+Python+FE together)

Sequencing decision: phases land in BOTH backends every time (no parity debt), in
this order:

```
DONE:  31 audit → 7/8 payout engine → 3 availability → 34 harness + 014 scaffolding
NEXT:  4 KYC ─┬→ 22 account status      (same screens; feeds the payout auto-hold
              │                          that already checks pandit KYC)
       5 profile ─→ 17 QA engine          (same pandit surfaces)
       9 tiers + 10 transactions ledger   (engine consumes the tier resolver;
                                           ledger exists before cancellation rewrites)
       16 cancellation engine             (writes REFUND/ADJUSTMENT ledger entries)
       18 trial ─→ 23-25 agreements       (completes onboarding: KYC→agreement→trial→activation)
       20 incidents · 6 photo date gate   (small, standalone; audit ready for overrides)
       12 temples · 11 puja pricing · 13 NRI · 14 coupons   (admin CRUD cluster)
       26 leads · 27-29 comms/campaigns/notifications        (largest build)
LAST:  15 polish · 30 reports (absorb all new modules) · 32 dashboard (aggregates all)
       33/35/36/37 sweeps → 38 delivery report
```

Rationale: money-adjacent phases precede the onboarding chain because payout holds
and the ledger are already wired; reports (30) and dashboard (32) go last because
they aggregate every other phase — building them early guarantees rework.
