# Phase 4 audit — Page Network (before and while building)

Base: `main` @ `110e637` (Phase 3 merged as PR #4, all three checks green). Branch `phase4-page-network`. Nothing below was changed before it was read; this document is what the code and the database actually contained.

## 1. What already existed

| Concern | What the repository had | Source |
|---|---|---|
| Thematic page | `ManagedPage`: `name`, `slug`, `description`, `status` (ACTIVE/ARCHIVED). A **minimal label** created in Phase 2 so Upload-Post profiles could be mapped to something. No platform, no username, no category, no editorial data. | `schema.prisma`, Phase 2 migration `20261119120000` |
| How a page was connected | Only **through an Upload-Post profile**: `upload_post_profiles.managed_page_id` (one profile → one page, a page may own several profiles). There was no page → destination link. | `upload-post.service.ts` `setProfileMapping` |
| Publishing destination | `SocialAccount` (+ for Upload-Post: a 1:1 `UploadPostConnectedAccount`). Created only by the *enable destination* flow. | Phase 2 |
| Creator | `Creator` (person), mapped from `upload_post_accounts.creator_id`. | Phase 2 |
| Page category / group | **Nothing.** TD-10, TD-12, TD-48. | `TECHNICAL_DEBT.md` |
| Campaign | `Campaign` (name, status, dates, `auto_schedule_on_approval`) with `Content.campaign_id`. No relation to pages. | `schema.prisma` (model from the original app; Phase 3 added `auto_schedule_on_approval`) |
| Artist | Free-text `Sound.artist`. | Decision 2, Phase 3 |
| Audit | `AuditLog` (string `action`, so new actions need no migration); existing `MANAGED_PAGE_CREATED/UPDATED`. | `audit-log.repository.ts` |
| Roles | OWNER > ADMIN > EDITOR > VIEWER. No creator role. | `@socialith/auth` |
| Existing consumers of `ManagedPage` | 19 files: the Upload-Post mapping screens, the Publishing Center's destination DTO and filters, and their tests. | grep |

## 2. The central decision: extend `ManagedPage`, do not add a second page model

The brief asks for pages "separate from creators, publishing accounts and Upload-Post profiles" and warns against duplicating accounts. A new model next to `ManagedPage` would have produced two page records for the same thing, with the Phase 2 mapping pointing at the wrong one.

**Chosen:** extend `managed_pages` **in place** with ten *nullable* columns (category, platform, username, profile URL, target audience, language, editorial identity, structured profile, internal notes, destination link). No column was renamed or dropped; a Phase 2 row stays valid and simply shows as an *incomplete page profile* until an administrator fills it in (tested: a page created through the old endpoint is listed, flagged and completable).

Rejected alternatives: (a) a separate `ThematicPage` model — duplicates `ManagedPage` and orphans the Phase 2 mapping; (b) putting the page fields on `SocialAccount` — that is exactly the conflation TD-12 warns about.

## 3. The four entities and how they stay separate

| Entity | Table | Owned by | Relation to a page |
|---|---|---|---|
| Thematic page | `managed_pages` | Page Network | itself |
| Publishing destination | `social_accounts` (+ `upload_post_accounts`) | Upload-Post integration | **referenced** by `managed_pages.social_account_id` (unique: one destination serves one page); never copied or recreated by the Page Network |
| Upload-Post profile | `upload_post_profiles` | Upload-Post sync | unchanged Phase 2 mapping `managed_page_id`; shown on the page, never written by the Page Network |
| Individual creator | `creators` | Phase 2 mapping | **none**: a creator-owned account is refused as a page destination and no creator data is returned by any page endpoint |

## 4. Conflicts found and how they were resolved

| Finding | Resolution |
|---|---|
| Two ways to connect a page to an account now exist: the Phase 2 profile mapping (brand level, many platforms) and the Phase 4 destination link (one platform). | The direct link **wins** wherever a page is reported (Publishing Center destination, filters). A profile mapped to a *different* page is shown as a note on the page and never changed automatically (TD-56). "Keep existing Upload-Post account mappings intact": a test proves the profile, the connected account and the destination rows are untouched by linking. |
| Nullable columns and SQL's NULL logic (the Phase 3 lesson: `NOT (col = 'X')` drops NULL rows). | The new queries only test nullable columns with explicit `IS NULL` / `IS NOT NULL` (no `NOT (col = x)` on a nullable column); `(organization, platform, username)` is unique and NULLs do not collide, so legacy rows with no platform/username are safe. |
| Same page name on two platforms collides on the Phase 2 `(organization, slug)` unique. | Auto-derived slugs get a platform suffix (`football-page`, `football-page-tiktok`); an explicitly given duplicate slug is a 409. |
| `destinationFacts` (what makes a destination "ready") was built inline in two Publishing Center services. | One shared builder (`destinationFactsOf`) now serves the Publishing Center and the page mapping, so the two can never disagree. Behaviour of the Publishing Center is unchanged (its suites pass untouched). |
| The campaign detail screen calls `GET /api/analytics/campaigns/:id`, which answers 500 on MySQL (PostgreSQL-only `DISTINCT ON`). | **Fixed in the Phase 4 final fix** (TD-54, now resolved): the same PostgreSQL-only pattern was also in the dashboard queries and the shared rollup; all were ported to MySQL 8.4 with regression tests (PAGE_NETWORK_TESTING.md §6). A sibling in the worker is recorded as TD-59. |
| Group preferences vs a page in several groups: which group wins? | Undecidable without a context, so a group layer is applied only when a group is named (preview, text check). TD-55. |

## 5. Rules the audit set for the implementation

1. Additive migration only; verified on a fresh MySQL 8.4 (full chain, no drift).
2. A page never creates or fakes an account: a link needs an **existing** destination of the page's platform, not a demo/seed account, not already used, not a creator's.
3. Connection state is **derived on every read** from the destination and provider rows with the same checks the Publishing Center applies before scheduling. Nothing is stored, so nothing can go stale.
4. Page rules and originality are guidance: warnings by default, errors only if the page (or its category) says `BLOCK`. Nothing claims a text is true or original.
5. Reading is open to every role; creating, editing, archiving, grouping, linking and assigning are administrator actions; internal notes and provider internals are hidden below EDITOR; every write is audited with the actor and without free-text notes.
6. No AI, no media rendering, no automatic text placement, no repetitive or engagement features (Phase 5/6 and out of scope).

## 6. Not touched

`SocialAccount`, `PlatformConnection`, `UploadPost*` models and sync, the scheduling/approval engine and worker, `Sound.artist`, existing migrations, the legacy PostgreSQL stack, and `main`.
