# DaivikPooja — Master Technical Audit (Phases 0–2)

Authoritative feature/status map produced before any Phase 3+ implementation, per the
master prompt's AUDIT → MAP → DEDUPLICATE rule. Statuses:
`WORKING` (exists, tested, in use) · `PARTIAL` (exists, incomplete) · `BUGGY` ·
`DUPLICATED` · `MISSING` (not implemented anywhere).

Verification baseline at audit time: Node 28/28, Python 82/82 (incl. 11 CI-wiring
guards), UI smoke clean, CI green on `ba94637`.

Legend — **N** = Node/Express (`server/`), **P** = FastAPI port (`backend-python/`,
Node-parity contract), **FE** = `public/js/` SPA, **DB** = SQLite schema.

---

## 0. Inventory snapshot

| Layer | Count | Notes |
|---|---|---|
| N endpoints | 102 | admin 63, customer 15, kundali 9, pandit 9, auth 6 |
| P endpoints | 58 | admin 12, media 11, customer 11, kundali 9, auth 7, pandit 5, reports 2, payments 1 |
| N tables | ~50 | `server/db.js` + migrations 001–011 |
| P models | 40 | `app/models.py`, mirrored incl. kundali set |
| FE | 8 JS files, ~924 LOC + `account.js` | hash router in `main.js`; portals in `portal-admin.js` |
| Reports | 27 ids | `server/routes/admin.js:380` REPORTS + openpyxl port (`reports.py`, `xlsx.py`) |
| Tests | Node 28, Python 82 | `tests/api.test.js`, `backend-python/tests/` |

**Standing Python-parity gaps** (recorded pre-audit, re-confirmed): admin puja editing,
pandit registration/KYC uploads, campaigns/leads management, Excel admin-kundali
settings. Every Phase 3+ feature must land in both N and P or be explicitly listed as
a parity exception.

## 1. Feature/status map by master-prompt phase

### Phase 3 — Pandit availability calendar
| Aspect | Finding |
|---|---|
| Existing | `pandits.off` JSON array of ISO dates (whole-day off only); `pandits.avail` boolean; `is_free()` in `server/services/bookings.js:18` checks status/avail/off/booking-conflict; partial unique `idx_pandit_slot` prevents double-booking; `autoPick()` sorts by spec/city/rating; pandit calendar UI `pCal()` in `portal-admin.js` (tap-to-toggle off); P: `POST /pandit/availability` toggle (pandit.py:73) |
| Status | **PARTIAL** — per-date off + slot conflict exists; no time slots config, no weekly-off patterns, no holidays, no blocked-date reasons, no home-radius, no online/temple capability flags |
| Required | One availability module: extend `pandits` (+ maybe `pandit_availability` table via migration 012) with weekly-off, slots, radius_km, online_enabled, temple_enabled, holidays; **extend** `is_free()` with the full bookable formula; auto-assign respects it; FE calendar gains slot/weekly-off editing; P mirrored |

### Phase 4 — Pandit KYC
| Aspect | Finding |
|---|---|
| Existing | `pandits.kyc` JSON; `status` pending/verified/rejected; admin Approve/Reject (`akyc` act, portal-admin.js pandits tab); doc-view buttons (`adoc`); registration upload slots in `regPandit()` FE; N: no kyc_documents table (docs live in the JSON / uploads) |
| Status | **PARTIAL** — binary approve/reject only; no UNDER_REVIEW/EXPIRED/REVERIFICATION_REQUIRED, no expiry dates, no reminders, no per-document records |
| Required | Extend: `kyc_documents` table (migration) + status vocabulary + admin KYC screen columns (verified-by/date, expiry, next-reverification) + reminder surface in notification engine; P gets the missing upload/verify endpoints |

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

### Phase 7/8 — Earnings & payout engine
| Aspect | Finding |
|---|---|
| Existing | `payouts(id, pandit_id, amount, date, status, booking_id)`; status Pending/Paid; created on booking completion with commission at that moment; commission = `getSetting('commission', 20)` (bookings.js:182) — **settings-driven, not hard-coded**; pandit earnings tab + admin finance payouts table; 27-report registry includes payouts/commission |
| Status | **PARTIAL** — no ON_HOLD/PROCESSING/DISBURSED/FAILED/REVERSED, no hold reasons, no per-payout breakdown (gross/commission/tax/adjustment/UTR), single global commission |
| Required | Extend `payouts` columns (status vocab, hold_reason, refs, breakdown JSON); centralize calc in a payout engine service (N+P) that both booking completion and admin use; earnings tab shows the required views |

### Phase 9 — Commission tiers
| Aspect | Finding |
|---|---|
| Existing | Single `commission` setting |
| Status | **MISSING** (tiers) |
| Required | `commission_tiers` table (tier/category/pct/effective dates) + resolver service consulted by the payout engine; admin UI in finance tab; settings default stays fallback |

### Phase 10 — Dakshina
| Aspect | Finding |
|---|---|
| Existing | `payments` table; bookings carry pay JSON; no transaction-type ledger |
| Status | **MISSING** (typed ledger) |
| Required | `transactions` table (SERVICE_PAYMENT/DAKSHINA/REFUND/COMMISSION/PAYOUT/ADJUSTMENT) written by the payment/payout paths; pandit dashboard + admin reports show Dakshina separately (+ report id) |

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
| Existing | Nothing (grep: 0 matches) |
| Status | **MISSING** |
| Required | `trial_poojas` table + admin form + result vocab (PENDING/PASSED/FAILED/REASSESSMENT_REQUIRED); gate activation flow |

### Phase 19 — Complaints
| Aspect | Finding |
|---|---|
| Existing | `tickets` + `ticket_messages` + `login_activity`; customer submit from booking; admin resolve button |
| Status | **PARTIAL** — Open/Resolved only; master workflow OPEN→UNDER_REVIEW→PANDIT_RESPONSE→CUSTOMER_RESPONSE→DECISION→RESOLVED not implemented; no evidence attachments |
| Required | Extend tickets status vocab + admin workflow controls + attachments (reuse media upload path) |

### Phase 20 — Incident reporting
| Aspect | Finding |
|---|---|
| Existing | Nothing |
| Status | **MISSING** |
| Required | `incidents` table (categories as specified) + pandit "Report incident" + admin triage; link to booking/customer |

### Phase 21 — RBAC
| Aspect | Finding |
|---|---|
| Existing | Roles: admin/customer/pandit via JWT; admin-only exports audit-logged; pandit portal shows masked mobiles; no FINANCE/CUSTOMER_SUPPORT/SUPER_ADMIN, no permission matrix |
| Status | **PARTIAL** |
| Required | Extend users role vocab + permission map (pandit must never export); permission checks in admin routes by sub-role |

### Phase 22 — Pandit account status
| Aspect | Finding |
|---|---|
| Existing | `pandits.status` pending/verified/rejected; account management (009) suspends logins (users.status) |
| Status | **PARTIAL** — suspension exists at login level; no UNDER_REVIEW/SUSPENDED/TERMINATED lifecycle with reasons/dates/payout-hold linkage |
| Required | Extend pandit status vocab + suspension record (reason/start/end/review date) + termination checklist effects |

### Phases 23–25 — Agreements
| Aspect | Finding |
|---|---|
| Existing | Nothing (grep: 0 matches) |
| Status | **MISSING** |
| Required | `agreements` (versions, publish/archive, document hash, manual upload) + `agreement_acceptances` (OTP/IP/device/audit, version-locked) + admin screens + pandit acceptance flow; never overwrite accepted versions |

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

### Phase 31 — Audit log
| Aspect | Finding |
|---|---|
| Existing | `audit_logs` + admin audit tab; all exports and sensitive account actions logged |
| Status | **PARTIAL** — lacks old/new value, reason, IP, device columns |
| Required | Extend table + central `audit()` helper with structured payloads; retrofit the master prompt's listed actions |

### Phase 32 — Dashboard
| Aspect | Finding |
|---|---|
| Existing | Admin dashboard KPIs (bookings, gross, commission, active pandits, KYC pending, unassigned, tickets, refunds) |
| Status | **PARTIAL** — add pending agreements, today's pujas/revenue, payout pending/on-hold, incidents, campaigns, leads, kundalis-generated |

### Phases 33–37 — Validation, security, dedup, regression, quality
- E2E workflows to script-test: onboarding, booking (with availability), customized puja, KYC, agreement, payout.
- Security tests to add: pandit cannot export/access others' data; photo date gate; coupon/commission/payout manipulation; duplicate booking/payment/payout (idempotency_keys exists — reuse).
- Duplication sweep after implementation; no dead code/placeholder buttons (FE note: analytics "Sample" KPI and incentives text are static copy — verify and either wire or label).

### Phase 36 — Do-not-break list
Demo accounts (`u1`, `p1`, admin env creds, OTP 123456 demo mode), demo reset, mock
bookings, kundali free-quota model, existing 27 reports, media pipeline, both test
suites — all must stay green after every phase.

## 2. Duplication map (Phase 1) — known forks to keep single-source

| Function | Single source | Duplication risk to avoid |
|---|---|---|
| Pricing/quote | `shared/pricing.js` | Never re-derive commission/discount in services |
| Commission | `getSetting('commission')` | Do not introduce a second constant |
| Availability | `is_free()` in bookings.js | New rules go INSIDE it, not beside it |
| Refunds | `cancelInternal()` | No parallel refund writer |
| Excel export | REPORTS registry + xlsx port | New reports added to BOTH registries, not ad-hoc |
| Notifications | `notify.js` | No per-module notification logic |
| Audit | db.js audit helper | No direct audit_logs INSERTs scattered |
| Media upload | multer+sharp pipeline | Photo gate wraps it, does not fork it |

## 3. Migration safety (Phase 2)

Migrations 001–011 exist and are idempotent-ordered. Baseline rules for 012+:
1. Every new column/table checked against the inventory above first (`IF NOT EXISTS`).
2. No destructive changes to users/pandits/bookings/payments/kundalis/coupons data.
3. SQLite migration + mirrored SQLAlchemy models in the same commit; both test suites
   seeded/verified after each migration.
4. Extension-first: `pandits`, `payouts`, `coupons`, `tickets`, `leads`, `campaigns`,
   `audit_logs`, `reviews`, `temples` get columns — new tables only for genuinely new
   entities: kyc_documents, commission_tiers, transactions, nri_packages, trial_poojas,
   incidents, agreements, agreement_acceptances, qa_records, pandit_availability.
