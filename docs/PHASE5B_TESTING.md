# Phase 5B testing: Text Library and Content Recipe Engine

## 1. How to run

```powershell
pnpm lint
pnpm typecheck
pnpm test                         # all unit tests (no infrastructure)
docker compose -f docker-compose.mysql-test.yml up -d --wait mysql84 redis
$env:MYSQL_INTEGRATION_URL = "mysql://socialith:it-app-throwaway@127.0.0.1:3384/socialith_it"
$env:REDIS_INTEGRATION_URL = "redis://127.0.0.1:6390"
pnpm --filter @socialith/api test:mysql          # real MySQL 8.4 (+ Redis for the media suite)
pnpm --filter @socialith/worker test:integration # real MySQL 8.4 + Redis/BullMQ
```

The integration databases are throwaway (data on tmpfs). The new suites need MySQL only; they use the real express app on a random port, real sessions and the real RBAC. No test calls the real Upload-Post, an AI provider or R2.

## 2. Suites added in 5B

| Suite | Tests | Kind |
|---|---|---|
| `packages/studio`: `text.test.ts`, `recipe.test.ts` | 43 new (54 in the package) | unit, pure |
| `packages/media-pack`: `text-import/text-import.test.ts` | 32 new (95 in the package) | unit, real files on disk, hostile XLSX built by hand |
| `apps/api`: `text-library.integration.test.ts` | 35 | integration, MySQL 8.4, real HTTP |
| `apps/api`: `recipes.integration.test.ts` | 25 | integration, MySQL 8.4, real HTTP |

Totals after 5B: unit 54 + 95 + 48 + 30 + 237 + 75 + 13 + 111 + 45 + 37 (studio, media-pack, video-engine, config, api, worker, web, publishing, upload-post, auth); API integration **281** (221 before); worker integration **132** (unchanged, run as a regression).

## 3. What the owner's test list maps to

| Required | Where it is proven |
|---|---|
| TXT import | integration: one text per line, blank-line paragraphs; dry run changes nothing; real run imports PENDING texts with source row and batch; second run imports nothing. Unit: line/paragraph detection, forced mode. |
| CSV import | integration: semicolon file with a BOM, Turkish headers, quoted fields with separators and line breaks, per-row categories and languages; Windows-1254 file read and reported; default categories and applicability. Unit: RFC 4180 cases, delimiter detection, header detection (English and Turkish), explicit text column. |
| XLSX import | integration: first sheet, named sheet, Excel row numbers, header detection, categories. Unit: shared and inline strings, booleans, sparse cells and explicit row numbers, several sheets, formulas read as stored text. |
| Invalid file rejection | integration: wrong extension, PNG renamed `.csv`, UTF-16/binary, empty, `.xlsx` that is plain text, starts like a ZIP but is not, a ZIP that is not a workbook, entity-bomb XML, 5001 rows (413), no text column, no file, bad options JSON. Unit: encrypted workbook, zip-bomb part by real inflated bytes (40 MiB part), unsafe path, too many rows, no sheet by that name. |
| Duplicate text detection | integration: case/spacing/punctuation/Turkish-i variants refused with the existing id; `su` ≠ `şu`; archived duplicate pointed at; six concurrent identical creates → exactly one row; duplicates against the library and inside one file during import; edit into another text refused. Unit: the normalization itself. |
| Text category assignment | integration: several categories on one text, filters by category / uncategorized, set / add / remove in bulk, archived and foreign categories refused. |
| Text approval | integration: editors cannot approve; reject needs a reason; editing approved words resets approval (audited); restricted rights block approval and demote; archive/restore semantics; bulk approve skips archived and restricted with reasons. |
| Recipe creation | integration: presets listed and installed once, from-preset with free names; create with validation (unknown keys, bad colors, unknown font, out-of-range, empty media, unknown format, long name); duplicate names; version bump on edit only when something changed. Unit: schema defaults, round trip, presets valid and font-safe. |
| Recipe inheritance | integration and unit: category defaults, page overrides category, group between, recipe explicit overrides both, preview adjustment overrides all and is labelled, the source of every setting; font the renderer lacks falls back with a warning; non-hex colors ignored with a warning. |
| Individual page overrides | integration: a page with its own `textPosition` / colors beats its category for those fields only (`vertical: page`, `font: category`). |
| Recipe duplication | integration: settings, assignments, text category and format copied; named `(copy)`, `(copy 2)`; traceable (`duplicatedFrom`, `presetKey` kept); independent afterwards. |
| Page group compatibility | integration: a group target is compatible through its members' pages and categories; a recipe or text limited elsewhere is flagged; a group layer applies only when the page is a member (400 otherwise). Unit: matching and ordering page > group > category > everyone, media filter, archived excluded. |
| Media compatibility | integration: kind not accepted, file not ready, rights restricted, unmeasured, too small, aspect difference explained, animation on a still image, audio refused. |
| Preview configuration persistence | integration: saved choices and adjustments come back when the recipe is read again, saving does not touch the recipe or its version, can be cleared, foreign ids refused. Browser: choices restored after a page reload. |
| Permissions and audit | integration: viewer / editor / admin on every write route (including each bulk action), organization isolation (404) on every read and write, audit entries with the acting user and, for edits, the changed field names (never text content). |

## 4. Defects the tests found (and the fixes)

* **Organization deletion failed in MySQL** (error 1452) when `text_usages` and recipes had `SET NULL` links that sit on the same cascade path as the organization's own cascade. Fixed by making those references plain ids (§10 of `TEXT_LIBRARY.md`); the migration was regenerated before it was ever applied outside tests.
* **Windows-1254 text files were refused** by the strict UTF-8 signature gate that the media library uses. The text import now accepts legacy single-byte text (no NUL bytes, almost no control characters, not a known binary signature) and decodes it explicitly.
* Test-source hygiene: literal invisible characters in test and source strings were replaced by `\u` escapes (they tripped `no-irregular-whitespace` and are invisible in review).

## 5. Browser verification (manual, throwaway database, real API + worker + FFmpeg)

Signed in as the seeded owner on a local development database:

* Starter text categories added from the organize page.
* A real Turkish semicolon CSV (BOM, quoted comma, a case/Turkish-i duplicate of an earlier row, an empty row, an unknown category) checked first: *6 new, 1 repeated in the file (row 7 = row 2), 1 warning*; the unknown category was reported, not created. Imported: 6 texts, each "needs review" with its category and source file.
* All six selected and approved in bulk ("6 texts approved"); the tab counters moved from Needs review 6 to Approved 6.
* Presets installed ("Add all 5"), a page category and pages with visual preferences seeded, the Motivation preset opened with the page, a video from the Media Library (uploaded and analysed by the worker earlier in the session) and an approved Turkish text: the text appeared in the **page's** upper third (the page overrides the category's lower third) in the **page's** color, serif bold from the recipe; the badges read *recipe*, *from page*, *default* as they should.
* A recipe setting changed (vertical position) → "unsaved changes" → saved → stored version 2 with the new value; preview choices remembered and restored after reload.
* Layout: no horizontal page overflow at phone width. **Known, pre-existing:** the application's sidebar does not collapse on phones, so every screen (not only these) is cramped there (TD-65).
* One thing the check found: the preview played its exit animation once and then stayed blank; it now loops a cycle of at most 8 seconds.

Not checked in a browser: the viewer role (covered by the integration tests), the reduced-motion preference (implemented, not exercised), and XLSX through the browser (covered through the API tests with generated workbooks).

## 6. Not tested, on purpose

Real FFmpeg rendering of recipes (5C), AI providers (5D), automatic usage entries from publishing and rendering (5C/5F), real R2 (TD-61).
