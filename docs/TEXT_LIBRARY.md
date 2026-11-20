# Text Library (Phase 5B)

The words Socialith's pages may say, kept as reviewed, organized, searchable records. **Socialith never writes, completes or "improves" a text, a lyric or a fact.** A text is a person's text: typed in, or imported from a file the person supplies. AI-assisted drafting arrives in Phase 5D and, like everything else, will enter this library as a pending text that an administrator has to approve.

Screens: **Content Studio → Text Library** (`/studio/texts`), **Import file** (`/studio/texts/import`), **Categories and collections** (`/studio/texts/organize`), and one page per text (`/studio/texts/:id`).

## 1. What a text has

| Field | Meaning |
|---|---|
| Text | Exactly the words that will be used. Cleaned on the way in (line endings, control characters, invisible and bidi-override characters removed, blank-line runs collapsed); never reworded. At most **2000 characters**. |
| Categories | Any number of text categories, only when someone assigns them. The starter set (one click for an administrator) is **Motivation, Football, Humor / Memes, Relationships, Lifestyle, Artist campaigns**; custom categories are ordinary categories. |
| Language | A language code (`tr`, `en`, …) or not set. |
| Source, author | Where it came from and who wrote or said it, **only as provided**; never inferred. |
| Usage rights | `Not verified` (default), `Confirmed: we may use it`, or `Restricted: do not use`. Set by administrators; Socialith does not check them for you. |
| Applicability | Optional limits: **page categories**, **page groups**, **pages** (the existing Page Network models, referenced, never copied) and **campaigns**. No limits = suits every page. |
| Approval | `needs review` → `approved` / `rejected` → `archived`. |
| Usage history | Where the text was actually used (see §6). |
| Collections | Hand-picked sets of texts (administrators). |

## 2. Approval

* A new or imported text always starts as **needs review**. Nothing is approved automatically, not by import, not by AI.
* **Administrators** approve, reject (a reason is required), archive and restore. Editors can add, edit, import and assign; viewers read.
* **Changing the words of an approved text sends it back to review**: an approval belongs to the exact words that were approved. Changing metadata (language, author, notes) does not.
* A text marked **Restricted** cannot be approved; marking an approved text Restricted sends it back to review.
* Archiving hides a text from the default list and from the recipe preview. Restoring brings an approved text back as approved (its words cannot change while archived) and anything else back as needing review.
* Every decision is audited (`TEXT_APPROVED`, `TEXT_REJECTED`, `TEXT_ARCHIVED`, `TEXT_RESTORED`, `TEXT_RIGHTS_CHANGED`) with the person who made it.

## 3. Duplicate detection

The same text exists **once per organization** (enforced by a unique index, so two people adding it at the same moment cannot both succeed). Two texts are the same when they match after ignoring **case, spacing and punctuation** and folding the **Turkish dotted/dotless i**: `KAPI açık, gel!`, `kapı  AÇIK gel` and `“Kapı açık, gel”` are one text. Letters are otherwise not folded: `su` and `şu` are different words and stay different.

* Adding a duplicate by hand answers 409 and points at the existing text (and says if it is archived, so it can be restored instead).
* An import reports a duplicate against the library and against **earlier rows of the same file**; nothing is added twice.
* Near-duplicates (similar but not identical wording) are **not** detected here; the Publishing Center's repetition guard still applies at publication time.

## 4. Search and filters

Search finds words, author and source **without Turkish letters** (typing `guzel` finds `Güzel`; the database collation would not, see TD-30). Filters: status (the review queue is the default tab), category, language, collection, source type, rights, used or never used, campaign, page category, page, page group, import batch, and **"usable for page X"** (texts limited to that page, its groups or its category, plus texts limited to nothing). Sorting: newest, oldest, text, most used.

## 5. Bulk work

Select texts and act on all of them: **categorize** (add, remove, set), set the **language**, assign **campaigns, page categories, page groups, pages**, and (administrators) **approve, reject, archive, restore, set rights, add to or remove from a collection**. Each request is all-or-nothing about ownership (an id from another organization changes nothing), and texts that cannot take an action are **skipped with the reason** (archived, "do not use"), never silently.

## 6. Usage history

A text's history records where it was used: when, on which page and campaign, with which recipe and source file, and the publication (`Content`) it belongs to. References are plain ids on purpose: the history survives the later removal of what it points at (the interface then shows the reference as gone). **A preview never counts as a use.** A person can record a use (`Record a use`, approved texts only); **a successful render adds a `RENDER` entry automatically** (Phase 5C: the text, page, campaign, recipe and the output file; exactly one per output, even if the job is delivered again, and none if the text was deleted meanwhile). Publishing (5F) will add its own. Only an **approved** text can be recorded as used.

## 7. Import: TXT, CSV, XLSX

`Import file` checks first (a **dry run**: nothing changes, you see what would happen), then imports.

| Format | How it is read |
|---|---|
| TXT | One text per non-empty line, or paragraphs separated by blank lines (detected; can be forced). |
| CSV | RFC 4180: quotes, doubled quotes, delimiters and line breaks inside quotes. The separator (`,` `;` tab `|`) is detected (Excel in Turkish and German locales writes `;`). UTF-8, with or without BOM, or **Windows-1254** ("Turkish ANSI", what older Excel and Notepad save): the encoding used is reported. |
| XLSX | The first sheet, or a named one. Read without any spreadsheet engine; formulas are never evaluated (the stored result is read as text). |

Columns (CSV and XLSX), recognised by header in English or Turkish, in any order: `text` (`metin`), `category` (`kategori`, several separated by `;`, `|` or `,`), `language` (`dil`), `source` (`kaynak`), `author` (`yazar`), `notes`. A single column without a header is all texts. If no header is recognised you name the text column.

Per row the result is **new**, **already in the library**, **repeated in the file** or **cannot be imported** (empty, or over 2000 characters), with the file's own row number; unknown category names are **not applied and not invented** (an administrator may choose "create the categories named in the file"); an invalid language code is ignored with a warning. Defaults for rows that carry nothing (categories, language, source, applicability) can be set for the whole file. Imported texts are `needs review`; the import is recorded as a batch (file name, size, SHA-256, counts, a bounded list of problems) and every text keeps its batch and row (`Where it came from`).

### Import safety

* The upload is streamed to disk, limited by `TEXT_IMPORT_MAX_BYTES` (5 MiB) and `TEXT_IMPORT_MAX_ROWS` (5000); a file over a limit is **refused whole** (413), never silently cut short.
* Extension **and** content must agree (magic bytes, declared MIME); a PNG renamed `.csv`, a binary or UTF-16 file, an empty file, and an `.xlsx` that is not a workbook are refused with a plain reason.
* XLSX is a ZIP of XML, so it is read defensively: only the workbook, its relationships, the shared strings and **one** sheet are read; every part is bounded **on the bytes that actually inflate** (32 MiB per part, 64 MiB total, 200:1 ratio), encrypted workbooks, more than 500 parts, unsafe part paths and any part with an XML `DOCTYPE`/`ENTITY` declaration (entity bombs) are refused; nothing is written to disk.
* Importing needs the editor role; creating categories from a file needs an administrator.

## 8. Permissions

| | Viewer | Editor | Admin / Owner |
|---|---|---|---|
| Read texts, usage, categories, collections | yes | yes | yes |
| Add, edit, import, assign, bulk categorize / language / assign, record a use | | yes | yes |
| Approve, reject, archive, restore, set rights, bulk of those | | | yes |
| Manage categories and collections | | | yes |

All routes require a session, are scoped to the organization (another organization's id answers 404) and the service layer repeats the administrator checks (including inside bulk actions).

## 9. API (all under `/api/text-library`)

`GET summary`; `GET|POST categories`, `POST categories/starters`, `PATCH categories/:id`, `POST categories/:id/archive|restore`; `GET|POST collections`, `PATCH collections/:id`, `POST …/archive|restore`, `POST|DELETE collections/:id/texts`; `POST imports` (multipart `file` + `options` JSON); `GET|POST texts`, `POST texts/bulk`, `GET|PATCH texts/:id`, `PUT texts/:id/categories|campaigns|page-categories|page-groups|pages|rights`, `POST texts/:id/approve|reject|archive|restore`, `GET|POST texts/:id/usages`.

## 10. Data (migration `20261123100000_text_library_and_content_recipes`, additive)

`text_categories`, `text_entries` (unique `(organization_id, normalized_hash)`), `text_entry_categories|campaigns|page_categories|pages|page_groups`, `text_collections`, `text_collection_items`, `text_import_batches`, `text_usages`. References that must survive removal of their target (`text_usages.*`, `text_entries.import_batch_id`) are plain ids, not foreign keys: MySQL cannot cascade an organization delete through `SET NULL` links that share a cascade path (found by the integration suite's cleanup).

## 11. Not in this phase

AI drafting and rewriting (5D); automatic usage entries from publishing (5F; rendering writes its own since 5C); near-duplicate matching; per-text approval workflows with several reviewers; export.
