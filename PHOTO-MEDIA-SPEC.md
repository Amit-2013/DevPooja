# Photo Media Specification

Rules every consumer — Admin panel, Pandit portal, Customer pages — follows for puja
media. One store (`puja_media`), one workflow, no parallel systems. Migration 010
carries the metadata; the admin UI, exports and the public API all read the same rows.

## Field rules

| Field | Rule |
|---|---|
| Owner | Admin (uploads + moderation) / Pandit (own uploads only) |
| Status | `PENDING_ADMIN_REVIEW` → `APPROVED` \| `REJECTED` (pandit uploads start pending; admin uploads start approved) |
| Visibility | Public = `APPROVED` **and** `is_published=1`; everything else is admin/pandit-only |
| Source | `seeded` \| `admin` \| `pandit` (column `source`; derived historically: `pandit_id` set ⇒ pandit) |
| License | Required for externally sourced (seeded) images (`license`) |
| Credit | Required for CC-licensed images (`credit` = attribution line, `credit_url` = source page, `creator` = author) |
| Primary | One per puja (`is_primary`); first admin upload or explicit "Primary" action |
| Sort order | Numeric `display_order`; ties break by `created_at` |
| Alt text | Required on upload (`alt_text`), used verbatim in `<img alt>` |
| Thumbnail | 320px copy generated at seed time (`thumb`); larger sizes served from the original |
| Original | Preserved untouched in `uploads/media`; downloads always stream the original |

## State machine

```
Seeded/Admin upload ──────────────► APPROVED (admin may publish/unpublish)
Pandit upload ─► PENDING_ADMIN_REVIEW ─► APPROVED (admin publishes) ─► public
                                      └► REJECTED (pandit-only visibility)
REJECTED / unpublished → never public; rejecting clears is_published
```

## Category (customer gallery tabs)

`category` ∈ `puja` \| `ritual` \| `temple` \| `seva` — the customer gallery groups
All / Puja / Ritual / Temple / Previous Seva. Seeded photos default by puja type;
admin can change it; pandit uploads default to `seva`.

## Who may do what

| Action | Admin | Pandit | Customer/public |
|---|---|---|---|
| Upload | any puja | own assigned bookings only | — |
| Approve / Reject | ✔ | — | — |
| Publish / Unpublish | ✔ | — (never) | — |
| Set primary / reorder | ✔ | — | — |
| Delete | ✔ any | own PENDING only | — |
| Download | ✔ any | own + published | published only |
| See pending/rejected | ✔ | own only | never |
