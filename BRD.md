# Business Requirements Document — DaivikPuja

**Sanatan Seva Platform**

| Field | Value |
|---|---|
| Document | BRD — DaivikPuja (Sanatan Seva Platform) |
| Version | 1.0 |
| Date | 4 October 2026 |
| Status | Approved baseline (as-built) |
| Sources | README.md, MASTER-AUDIT.md (technical audit), both running backends |
| Audience | Business owners, product, operations, engineering |

---

## 1. Business overview

**Vision.** DaivikPuja is a devotional-services marketplace that lets any family book a
properly performed puja — with a verified pandit, the right samagri and correct vidhi —
wherever they live, and receive proof and prasad afterwards.

**Problem.** Families who want to worship properly usually cannot find a trustworthy
pandit, and learned pandits cannot reach the families who need them. Ritual knowledge,
samagri sourcing and scheduling are fragmented, and there is no dependable record of what
was performed.

**Solution.** A three-sided platform:

1. **Devotees** discover pujas, get an instant quote, pick a slot and mode (home / online /
   temple / customised), pay, track the booking, receive photo evidence on the puja date,
   order prasad and samagri, and generate kundalis.
2. **Pandits** join through KYC and quality gates, publish availability, accept work, and
   are paid through a transparent commission and payout engine.
3. **Operations** run the marketplace from one admin console: verification, assignment,
   quality review, incidents and complaints, payouts, marketing, content and reporting.

**Differentiators.** Verified-pandit pipeline (KYC → agreement → trial → QA scoring);
evidence-based fulfilment (media gated to the scheduled date); an end-to-end audit trail
with old→new values and reasons; a bilingual (English/Hindi) single-page experience; and a
**Node↔Python parity contract** — every capability ships on both backends.

## 2. Objectives and success measures

| # | Objective | Measure |
|---|---|---|
| O1 | Complete more bookings | Bookings confirmed ÷ quotes issued; abandonment at payment |
| O2 | Keep fulfilment trustworthy | % bookings with on-date photo evidence; average QA score (1–5) |
| O3 | Resolve issues quickly | Complaint first response; % tickets resolved within 48h; incident reopen rate |
| O4 | Pay pandits fairly and on time | Payouts disbursed within cycle; no held payout without a reason |
| O5 | Retain devotees | Repeat-booking rate; reward-point redemption rate |
| O6 | Operate with a clean paper trail | 100% of privileged actions audited with actor, reason, old→new values |
| O7 | Ship without parity drift | Both backends pass their full suites on every commit (Node 143 / Python 198) |

## 3. Scope

**In scope (current platform).** Puja catalogue and discovery; the five-step booking wizard
with quote, coupons and reward points; availability and assignment; payments, ledger,
refunds, commission and payouts; prasad/samagri orders; temple sevas and NRI packages;
kundali and dosha services; pandit onboarding (registration, KYC, agreements, trials, QA);
complaints and incidents; trust-and-safety holds; notifications and campaign marketing;
leads CRM; content CMS (Our People, social links, gallery); admin dashboard, reports and
audit log; demo mode and static Pages deployment.

**Out of scope (this revision).** Native mobile apps; real banking/payout rails (mock
gateway by default); warehouse/inventory management for samagri; trust/charity donations;
third-party accounting; multi-currency settlement beyond NRI display pricing.

## 4. Personas and stakeholders

| Persona | Goal | Key rules that protect them |
|---|---|---|
| **Devotee (customer)** | Book a reliable puja and see it was performed | Sees only own data; complaint thread is theirs alone (404 for others); holds never block fulfilment silently |
| **Guest browser** | Explore catalogue, get a quote, preview kundali | Read-only; no writes without login; demo mode exposes pre-built snapshots only |
| **Pandit** | Get verified, receive work, be paid | Scoped to own bookings/tickets/KYC; masked customer contact; suspension holds payouts with a reason |
| **Admin / Operations** | Run the marketplace safely | Every privileged action role-gated and audited; destructive actions require a typed reason |
| **Temple partner** | Offer temple sevas and prasad fulfilment | Temple listings and offerings are admin-managed and commission-aware |
| **Customer support (future)** | Resolve complaints | Reserved sub-role in Phase 21 RBAC (not yet implemented) |
| **Finance (future)** | Release money | Reserved sub-role in Phase 21 RBAC (not yet implemented) |

## 5. Glossary

- **Puja** — a performed ritual; offered in modes *home*, *online*, *temple*, *customised*.
- **Samagri** — the material kit required for a ritual (kits are SKUs with contents).
- **Prasad** — blessed offerings dispatched to the devotee (pay-on-delivery orders).
- **Katha / Path** — scripted recitation (e.g. Satyanarayan Katha, Sundarkand Path).
- **Kundali** — horoscope chart; **Dosh** — astrological affliction with remediation advice.
- **Sankalp** — the intention statement that begins a ritual; captured in booking notes.
- **Review hold / Customer hold** — per-booking soft flags stamped while a pandit or
  customer is under review; they inform ops and never silently block fulfilment.
- **Ticket (complaint)** — a customer-raised issue thread: OPEN → UNDER_REVIEW →
  PANDIT_RESPONSE → CUSTOMER_RESPONSE → DECISION → RESOLVED.
- **Incident** — a pandit-reported field issue: OPEN → UNDER_REVIEW → RESOLVED | DISMISSED
  (reopenable with a mandatory reason).
- **Campaign** — one-off or scheduled message to an audience across five channels.
- **Lead** — captured enquiry moving NEW → CONTACTED → QUALIFIED → CONVERTED | LOST.
- **Trial / QA** — the quality gates scoring a pandit (pass mark 3.5 of 5).
- **DEMO_MODE** — seeded, resettable demo content guarded so it never overwrites real data.

## 6. Functional requirements

Acceptance criteria are stated per requirement; every requirement below is implemented on
**both** backends unless it is listed as an open item in section 12.

### 6.1 Catalogue and discovery
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-001 | Publish a puja catalogue with name, deity, description (EN/HI), duration, price | Catalogue renders publicly; Hindi copy shows when the language toggle is Hindi |
| FR-002 | Offer each puja in multiple modes with mode-specific pricing | Quote reflects the selected mode's price; switched-off services vanish from the header |
| FR-003 | Manage kits and prasad SKUs with stock/active flags | Inactive SKUs cannot be added to a cart or order |
| FR-004 | List partner temples with deities, offerings and timings | Temple page shows only active temples; offerings feed temple-mode bookings |
| FR-005 | Show a festival calendar with linked pujas | Festival rows deep-link to the relevant puja |
| FR-006 | Support NRI packages priced in USD/GBP with INR equivalents | Page shows the includes list and converted price; demo mode seeds three illustrative packages |

### 6.2 Booking and scheduling
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-010 | Five-step booking wizard: puja → slot → pandit → details → pay | Every step validates before advancing; the summary shows the final payable amount |
| FR-011 | Derive available pandits and slots from availability data | Booked slots and blocked dates never offer; account-status blocks return the reason |
| FR-012 | Create bookings with a full status lifecycle and history | Each status change appends to history with actor and timestamp |
| FR-013 | Auto-assign or admin-assign pandits | Manual assignment records the admin as actor; review holds stamp on assign |
| FR-014 | Photo/video evidence visible only on the scheduled date | Earlier uploads refused unless an admin date-gate override is granted (audited) |
| FR-015 | Customers raise complaints against their bookings | Ticket links to the booking when supplied; the booking must belong to the caller |

### 6.3 Pricing, coupons, payments, refunds
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-020 | Server-side quote: base × mode/pandit factors + add-ons, then GST and discount | The client never supplies the payable total; mismatched inputs are rejected |
| FR-021 | Coupons with type, value and min/max basket rules | Unqualified coupons return a stated problem, never a silent discount |
| FR-022 | Reward points: 100 points = ₹50, capped at 30% of puja value | Cap enforced server-side; balance decrements on use |
| FR-023 | Payments through the configured gateway (mock by default) | Mock completes end-to-end; live mode refuses unbuilt billing paths with 501 |
| FR-024 | Refunds governed by time-to-slot windows | Percentage computed from hours until the slot, never from wall-clock assumptions |
| FR-025 | Every money movement is double-recorded (payment + ledger rows) | The ledger report reconciles bookings against transactions |

### 6.4 Kundali and astrology
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-030 | Generate personal and family-member kundalis from birth data | Each generation is chargeable at the admin-configured price |
| FR-031 | Report doshas with plain-language explanations and remedies | Conditions render with Hindi copy where available |
| FR-032 | Recommend remediation pujas from the chart | Recommendations deep-link into the booking wizard |
| FR-033 | Admin controls kundali pricing and the feature toggle | Toggling astrology off removes it from navigation |

### 6.5 Commerce: orders, temples, NRI
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-040 | Prasad/samagri orders are pay-on-delivery with status progression | Admin advances Placed → Packed → Dispatched → Delivered; the customer is notified |
| FR-041 | Temple seva bookings route to a partner temple with an offering fee | The booking records the temple and its fee |
| FR-042 | NRI packages support foreign-currency display and INR conversion | The order stores the package reference and settled INR value |

### 6.6 Pandit lifecycle
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-050 | Registration with profile, specialities, languages and availability | Incomplete profiles are never published as verified |
| FR-051 | KYC document upload with admin verification | Files are stored outside the public media path; decisions are audited with a reason |
| FR-052 | Signed agreements recorded with version and acceptance | Archived agreements stay in history; acceptance is per pandit per version |
| FR-053 | Trial scheduling and assessment on 7 rubric dimensions | Partial assessments refused; PASSED is computed against the pass mark (3.5), never forced |
| FR-054 | KYC 'verified' is gated by a PASSED trial | The gate returns the exact blocking reason; already-verified pandits are grandfathered |
| FR-055 | QA scoring of completed bookings | Scores feed the pandit quality view and eligibility logic |
| FR-056 | Account lifecycle: ACTIVE / UNDER_REVIEW / SUSPENDED / TERMINATED | Suspension blocks login and new bookings immediately and holds open payouts |
| FR-057 | Pandit portal scoped to the pandit's own data | Another pandit's bookings/tickets return 404, never a probe |

### 6.7 Quality: incidents and complaints
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-060 | Pandits report incidents against their own bookings | Fixed category vocabulary; description ≥ 10 chars; foreign booking → 400, unknown → 404 |
| FR-061 | Admin triage with mandatory notes per state | UNDER_REVIEW needs a note, RESOLVED a resolution, DISMISSED a reason; closed is terminal |
| FR-062 | Dismissed incidents reopen with a mandatory reason | Reopen counter increments; RESOLVED stays final; every hop audited old→new |
| FR-063 | Repeat reopen patterns raise a queue digest | Above the threshold all admins get an in-app alert naming count and threshold |
| FR-064 | Complaint tickets run a six-state workflow on one shared state machine | Illegal transitions → 409; DECISION/RESOLVED require the written note; replies move status by role; RESOLVED refuses replies with actionable guidance |
| FR-065 | Ticket evidence rides the magic-checked media pipeline | Only /media/ URLs kept (max 8 per message); foreign strings dropped; anonymous upload → 401 |
| FR-066 | Both portals and the customer account open the same thread | The detail payload returns the legal next transitions so the UI never duplicates the rules |

### 6.8 Trust and safety
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-070 | Flagged pandit → review hold on NEW bookings only | Earlier bookings untouched; the pandit sees the reason verbatim on accept/start (409) |
| FR-071 | Flagged customer → soft customer hold, ops notified at stamp time | Fulfilment is never blocked; every admin gets an immediate in-app notification |
| FR-072 | Batch release of one customer's held bookings | Drill-in lists all held bookings; release writes one audited row per booking |
| FR-073 | Auto-release once every live incident resolves | The release reason distinguishes manual from auto; pandit and customer are notified |
| FR-074 | Suspension/termination enforced at login and booking | Existing tokens stop working immediately |

### 6.9 Notifications and communications
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-080 | One delivery engine for all channels (In-App, SMS, WhatsApp, Email, Push) | Every send writes a delivery record with SENT/SKIPPED/FAILED and reason |
| FR-081 | Per-customer consent and mutes | A muted channel (or mute-all) is SKIPPED with the reason; saving unrelated profile fields never wipes consent |
| FR-082 | WhatsApp provider adapter selected by environment | Default stub accepts without contacting a network; 'none' disables; the result lands in the delivery record |
| FR-083 | Campaign lifecycle DRAFT → SCHEDULED → SENDING → SENT/FAILED | Only drafts edit; cancellation only before send; per-recipient failures never abort a send |
| FR-084 | Scheduled campaigns fire automatically | A boot-armed sweeper catches up on campaigns that became due while the server was down |
| FR-085 | Notifications centre with read/unread state | Unread count on every signed-in state payload; mark-as-read is scoped to the caller |

### 6.10 Growth: leads and marketing
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-090 | Capture website leads with dedupe | A duplicate capture increments a duplicate counter instead of forking the record |
| FR-091 | Pipeline NEW → CONTACTED → QUALIFIED → CONVERTED/LOST | Only terminal states allow delete; conversion can create a manual booking |
| FR-092 | Follow-up dates surface as due alerts | Each newly due follow-up alerts once; rescheduling silences it |
| FR-093 | Excel import for customers and leads | Preview → commit flow; per-row errors are reported before anything is written |

### 6.11 Content management
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-100 | Our People CMS: categories, profiles, photos, order/visibility | Nine seeded categories; hidden people never appear publicly |
| FR-101 | Social links CMS feeding the footer | Active links render with the right icon; admins can reorder |
| FR-102 | Gallery CMS: albums, licensed photos, YouTube videos | License and credit provenance are stored per item |
| FR-103 | Puja photo management with moderation | Public media shows only published items; delete/bulk actions require reasons |

### 6.12 Administration, reporting and audit
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-110 | Admin dashboard of operational KPIs | KPIs derive from live rows, not cached numbers |
| FR-111 | Reports with Excel export on both backends | Files open with the platform title row; the export is audited |
| FR-112 | Audit log with actor, role, entity, detail, old/new value, reason, IP | The audit view shows reasons; entries are append-only |
| FR-113 | Service master switch plus per-service toggles | Switching services off hides every bookable entry point and pauses the header |
| FR-114 | Backup command producing a timestamped, WAL-checked snapshot | Keeps the newest N backups; never includes secrets |
| FR-115 | Demo RESET reseeds safely | Resets wipe allow-listed tables only and re-apply migration seed data |

### 6.13 Accounts, auth and access
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-120 | Login by OTP (demo code in demo mode), email/password and demo shortcuts | Failures are throttled and logged; OTPs are hashed, expire and are never logged |
| FR-121 | Roles: admin, customer, pandit | Wrong role → 403; anonymous → 401 on every protected route |
| FR-122 | Account types (normal / NRI) and profile consent on one account row | Profile saves merge rather than replace, preserving consent and mute |
| FR-123 | Admin password reset and account suspend/disable with reason | Both are audited with the typed reason |

## 7. Business rules

| ID | Rule |
|---|---|
| BR-01 | Payable = (base × mode factor × pandit factor) + add-ons, then coupon, then reward points (100 pts = ₹50, ≤ 30% of puja value), then GST — computed server-side only |
| BR-02 | Commission is taken from the pandit's share per configured tier; payouts are generated from completed bookings only |
| BR-03 | Cancellation refund follows hours-to-slot windows; refunds inside the no-refund window need an admin reason |
| BR-04 | Coupons enforce type, value and min/max basket bounds; one code per order |
| BR-05 | A review/customer hold applies only to bookings created or assigned while the flag is live |
| BR-06 | A pandit becomes bookable only after KYC verification, which requires a PASSED trial (≥ 3.5 mean of 7 dimensions) |
| BR-07 | Suspension/termination blocks login immediately and places open payouts on Admin Hold; termination is final |
| BR-08 | Booking media is visible only from the scheduled date unless an admin grants a dated, audited override |
| BR-09 | Incident DISMISSED is reopenable with a mandatory reason; RESOLVED is final; reopens above the threshold (2) alert all admins per crossing |
| BR-10 | Ticket DECISION and RESOLVED require the written note; the note is stored as the resolution and shown in the thread |
| BR-11 | Muted channels always win: the engine records SKIPPED with the mute reason rather than dropping silently |
| BR-12 | Demo content is seeded only into empty tables and wiped by RESET; demo tooling never touches production data |

## 8. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-01 | **Security** — JWT sessions, hashed secrets, OTP hashing and expiry, role checks on every protected route, magic-checked media uploads, rate-limited auth, no secrets or PII in logs |
| NFR-02 | **Data preservation** — destructive operations allow-listed and audited; migrations idempotent and ordered; backups first-class |
| NFR-03 | **Twin parity** — every feature lands on the Express/SQLite backend and the FastAPI/SQLAlchemy backend in the same change, or is recorded as an explicit parity exception |
| NFR-04 | **Auditability** — every privileged action writes actor, role, entity, old/new values and reason |
| NFR-05 | **Localisation** — English and Hindi copy for customer-facing surfaces |
| NFR-06 | **Accessibility** — labelled controls, keyboard-reachable flows, no native blocking dialogs in admin/pandit flows |
| NFR-07 | **Testability** — every business rule covered on both twins; suites gate every push (Node 143, Python 198 tests; UI smoke; Pages smoke of 131 assertions) |
| NFR-08 | **Deployability** — container image, Render blueprint, Netlify build and the static Pages demo derive from one source; migrations run at boot |
| NFR-09 | **Performance** — SQLite/WAL single-node profile; the static demo serves pre-built snapshots; media variants generated once and cached |

## 9. Data and compliance

- **Collected:** name, mobile, email, address, birth data (for kundali), family details,
  KYC documents, booking and payment records.
- **Handling:** KYC files are never served from the public media path; exports are
  admin-only and audited; passwords, OTPs and tokens never reach the audit log or console.
- **Retention:** transactional history is kept for continuity; demo RESET wipes only
  allow-listed tables; backups live on the operator's own storage.

## 10. Integrations

| Integration | Mode | Notes |
|---|---|---|
| Razorpay | mock (default) / live | Live mode refuses unbuilt billing paths with an explicit 501 |
| WhatsApp | stub (default) / twilio / none | Adapter selected by environment; result recorded per delivery |
| SMS (Twilio) | live when configured | OTP and transactional texts |
| Email (SendGrid) | live when configured | Transactional subjects carry the platform name |
| Excel export | exceljs (Node) / openpyxl (Python) | Same report ids and titles on both backends |

## 11. Assumptions and constraints

1. Single-tenant deployment per environment; SQLite (Node) and SQLite/Postgres (Python).
2. Payments run in mock mode until gateway credentials are supplied.
3. Demo mode is for evaluation; enabling it in production must stay a deliberate choice.
4. The GitHub Pages demo is read-only against pre-built snapshots.
5. The platform name is **DaivikPuja** everywhere user-visible (migrated from DaivikPooja
   by migration 035); data file paths and infrastructure resource names keep their
   historical identifiers so no data or deployment is orphaned.

## 12. Open items and roadmap

| Item | State | What remains |
|---|---|---|
| **Phase 21 — RBAC** | Done | FINANCE / CUSTOMER_SUPPORT seats, the permission matrix (`app/permissions.py` / `lib/permissions.js`) and sub-role guards on every admin route, pinned by `tests/rbac.test.js` + `backend-python/tests/test_rbac.py` |
| **Phase 30 — Reports** | Done | Both registries carry the 38 ids incl. KYC, incidents, agreements, commission tiers and NRI packages, pinned by `tests/reports.test.js` + `backend-python/tests/test_reports.py` |
| **Phase 32 — Dashboard** | Done | Landed on both backends (the `dash` summary block on the admin /state payload) and the FE KPI grid: pending agreements, today's pujas/revenue, payout pending/on-hold, incidents, campaigns, leads, kundalis-generated |
| Pages deploy on the secondary remote | Open (pre-existing) | The daivikpujarender Pages workflow fails at configure-pages because Pages is not enabled on that repository |

## 13. Appendix — verification baseline

- **Node suite:** 143 tests (API incl. kundali-history and the phase-32 dashboard,
  security, KYC, agreements, QA, ledger, cancellation, trial, incident, incident-digest,
  media date-gate, leads, review-hold, digest-sweep, comms, temple, pricing, NRI,
  coupons, accounts, people, socials, gallery, tickets, rbac, reports, and the
  i18n/mandala frontend gate) plus the regression runner.
- **Python suite:** 198 tests, including the audit-claims and CI-wiring guards.
- **UI smoke:** drives the real SPA in jsdom — NO UI ERRORS.
- **Pages smoke:** 131 assertions over the built static artifact.
- **Schema:** migrations 001–035 (Node) with mirrored SQLAlchemy models (Python).
- **Reference documents:** README.md (operator guide), MASTER-AUDIT.md (technical audit),
  DEPLOY.md (hosting), PARTNER-DEMO.md (partner walkthrough), PHOTO-MEDIA-SPEC.md.
