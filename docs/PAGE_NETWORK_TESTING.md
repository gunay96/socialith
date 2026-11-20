# Page Network — testing

Tiers: **automated tests** (pure rules + real MySQL/Redis through the real express app) and **a manual browser check** against the real API and database. No provider is ever contacted and nothing is published: destinations in the tests are rows shaped exactly like the Upload-Post integration leaves them.

## 1. Counts (last full run)

| Suite | Tests | Needs |
|---|---|---|
| `@socialith/publishing` (incl. `editorial.test.ts`, 24 new) | **111** | nothing |
| `@socialith/web` (incl. editor draft helpers, 5 new) | 13 | nothing |
| API unit | 237 (+1 POSIX-only skip) | nothing |
| Worker unit / config / auth / upload-post / video-engine | 75 / 22 / 37 / 45 / 7 | nothing |
| **API integration** | **178** (131 before + **47** in `page-network.integration.test.ts`) | MySQL 8.4 + Redis |
| Worker integration | 112 (unchanged) | MySQL 8.4 + Redis |

Phase 1-3 suites run **unchanged**; no assertion was edited or removed.

## 2. The requested test areas → where they are proven

| Requested | Proof |
|---|---|
| Page creation | all fields; username normalized (`@Motivation_01` → `motivation_01`); duplicate handle per platform 409, same handle on another platform fine; identical names get distinct slugs; non-http profile URL, unknown platform, empty name/username refused; a destination can be linked at creation; a Phase 2 page (name only) is listed as incomplete and can be completed |
| Page editing | edit changes only what was sent; audited without the notes text; platform locked while a destination is linked; an archived page is read-only until restored |
| Category management | create with every field, duplicate name 409, language defaults to the organization's, edit, archive (pages keep it, new assignment refused, restorable), starters added once without duplicating or overwriting an admin's own "Football" |
| Group assignment | create with pages, edit, filter groups by category and by platform, archive/restore; archived pages and archived groups take no members; foreign pages 404 and nothing changes |
| Multiple group membership | a page in two groups; adding twice changes nothing (one audit row); removing from one keeps the other; the page shows both; page list filtered by group |
| Editorial identity inheritance | a page without overrides inherits style, language, formats, visual and guidelines; every value carries its source; unit tests cover blanks, empty lists, nulls, invalid values and de-duplication |
| Individual override behaviour | per-field override with everything else inherited; a category change reaches inheriting pages but not an overridden field; a page's `false` beats a category's `true`; removing overrides returns to inheriting; group layer between page and category and only when asked |
| Account mapping | link shows provider, platform, handle, status, capability, Upload-Post profile, last sync; one destination ↔ one page (409 names the other); unlink frees it; the destination row is never created, copied or modified; wrong platform / demo / creator-owned / page without platform refused; Phase 2 profile, account and destination rows unchanged and a profile mapped to another page is flagged |
| Disconnected account handling | the live state follows the provider rows: account disconnected → DISCONNECTED; re-auth pending → REAUTH_REQUIRED; gone from profile → DISCONNECTED; profile removed / blocked, identity changed → UNAVAILABLE; destination switched off → DISCONNECTED; each with the plain-language issue; never READY unless truly ready; no destination → NO_DESTINATION and nothing fabricated |
| Campaign assignment | direct + group; effective pages are the union, once each, with every reason; idempotent; archived group stops contributing; un-assign page / group; foreign, unknown and archived ids refused and nothing assigned; page detail shows the campaign and why; content filtered by page category and by page |
| Permission checks | every role can read every GET; EDITOR and VIEWER get 403 on 16 write routes and nothing changes; OWNER may write; 401 without a session; internal notes and Upload-Post profile hidden from VIEWER, shown to EDITOR+ |
| Audit logging | every category/page/group/campaign/identity/destination action writes a row with actor and target; notes text never in metadata; a failed write writes nothing |
| Isolation and privacy | another organization's category/page/group/campaign is 404 on every read and write and never listed; no response contains a creator's name, notes or account; creator-owned and demo accounts are not offered as candidates |
| Page rules / originality | pure tests for length, avoided terms (Turkish i folding, suffixes, no mid-word hits), BLOCK vs WARN, verified-facts reminder, thresholds, look-back, off switch; API: advisory check, comparison with the page's own published posts; Publishing Center: warning by default, error and a refused submission when the page says BLOCK |
| Publishing Center touch points | publication DTO and destination list report the directly linked page; the page filter finds it and does not also report the profile-mapped page |

## 3. Browser verification (by hand, once)

Against the real API + MySQL 8.4 + Redis with a seeded throwaway organization (pages in every account state, three groups, a campaign): overview numbers matched the data (7 pages, 1 ready, 1 reconnect, 1 disconnected, creator account excluded from "unused"); pages list and filters; page details with inheritance (formats from the category, aspect ratio from the page); identity editor saving a rule and the text checker returning both warnings; account mapping with live states and reasons; groups and group detail with statistics; categories; the campaign card. As a **viewer**: no create/edit/archive controls, internal notes and provider profile hidden. **Found and fixed:** wide tables stretched the whole page (content container lacked `min-w-0`). **Found, not fixed (not this phase):** the campaign "Performance" block errors on MySQL (TD-54).

## 4. What is NOT verified

- **No real account was connected, published to, or contacted.** Account states come from synchronized rows; their relation to the live provider rests on the Phase 2 mapping that is itself unverified live (TD-45).
- The **Creator role does not exist**: privacy is proven by never returning creator data and by refusing creator-owned accounts, not by a creator login (TD-58).
- **No automated browser tests** (the check above was manual, as in Phase 3).
- **Scale**: the "account has a problem" filter is computed in memory (TD-57); tested with a handful of pages, designed for tens to low hundreds.
- Editorial formats, fonts, colors, positions and aspect ratios are stored preferences only: nothing consumes them until Phase 5/6.

## 5. Run it

```powershell
docker compose -f docker-compose.mysql-test.yml up -d --wait mysql84 redis
$env:MYSQL_INTEGRATION_URL = "mysql://socialith:it-app-throwaway@127.0.0.1:3384/socialith_it"
$env:REDIS_INTEGRATION_URL = "redis://127.0.0.1:6390"
npx --yes pnpm@9.0.0 test                      # all unit tests
npx --yes pnpm@9.0.0 test:integration          # api, then worker (MySQL + Redis)
docker compose -f docker-compose.mysql-test.yml down -v
```
