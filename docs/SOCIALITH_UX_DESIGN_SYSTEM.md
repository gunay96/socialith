# Socialith — UX design system

Status: **design document.** It records the interface requirements the owner approved and how they map onto what the dashboard already is. Nothing in sections 6-9 is implemented yet; they are the contract for Phase 5 and later. Companion: `LIVE_OPERATIONS_ARCHITECTURE.md` (where the live data comes from).

Provenance: the requirements below are the owner's list from the Phase 4 acceptance check. No earlier written version existed in the repository or its history, so this file is their first record. Anything beyond that list is marked *(proposal)*.

## 1. Requirements (owner-approved)

| # | Requirement | Where it is specified |
|---|---|---|
| R1 | Simple and intuitive dashboard navigation | §3 |
| R2 | Minimal premium dark interface | §2, §4, §5 |
| R3 | Centralized operations overview | §3.3, `LIVE_OPERATIONS_ARCHITECTURE.md` §3 |
| R4 | Real-time progress indicators | §6, `LIVE_OPERATIONS_ARCHITECTURE.md` §4, §6 |
| R5 | Animated progress bars | §6.3 |
| R6 | Campaign workflow visualization | §7.1 |
| R7 | Media processing progress | §7.2 |
| R8 | AI generation progress | §7.3 |
| R9 | Publishing queue progress | §7.4 |
| R10 | Worker and Redis health | §7.5 |
| R11 | Clear error messages with actionable solutions | §8 |
| R12 | **Progress comes from real backend job data; percentages are never invented; when progress cannot be measured, an indeterminate animation is used** | §6.1 (binding on every item above) |

## 2. What exists today (the baseline to keep)

Tokens (`apps/web/tailwind.config.ts`, `globals.css`) — dark-first, no light theme:

| Token | Value | Use |
|---|---|---|
| `background` | `#0a0a0a` | page |
| `surface` | `#141414` | cards, sidebar, tables |
| `border` | `#262626` | every divider and outline |
| `foreground` | `#fafafa` | text |
| `muted` | `#a3a3a3` | secondary text, hints, inactive nav |
| `accent` | `#3b82f6` | primary action, active nav |
| radius | 12 px | all containers |
| font | Inter, system fallback | everything |

Status colors are the four tones already used by the chips and banners (`lib/upload-post.tsx`): green = healthy / done, red = failed / disconnected, amber = needs attention, blue = information / in progress, neutral = nothing to report. Shared components: `Card`, `Stat`, `Banner`, `Chip`, `Pager`, `StateBadge`, `FilterBar`, the form `inputClass`. **New screens reuse these; they do not introduce a second component vocabulary.**

Already true of the product: a left sidebar with one entry per area; per-area tab bars (Publishing Center, Page Network); list → detail pages; plain-language statuses; actionable validation messages (Publishing Center `explainError`).

## 3. Navigation

### 3.1 Principles (R1)
1. **One place to look first.** The landing page answers "is everything working, and what needs me?" (§3.3).
2. **Few top-level entries, named for what the person does, not for the module.** Eight or fewer.
3. **Depth is two levels at most:** sidebar area → tab. A third level is a detail page reached from a list, never a menu.
4. **Every number is a link** to the filtered list it counts (already the pattern in the Publishing Center overview and Page Network overview).
5. **The same word means the same thing everywhere** (publication states, account states, "approval", "destination", "page").

### 3.2 Current sidebar and the proposed grouping *(proposal)*
Today: Dashboard, Accounts, Campaigns, Content, Music / Sounds, Page Network, Publishing Center, Upload-Post, Team. Nine flat entries; "Upload-Post" and "Accounts" are provider plumbing next to daily work.

Proposed order, visually grouped by a thin divider and a small muted heading, **same routes** (no URL changes):

| Group | Entries |
|---|---|
| Operate | **Operations** (new landing page, §3.3), Publishing Center, Campaigns |
| Create | Content, Music / Sounds, *(Phase 5)* Media Packs, *(Phase 5)* Text Library, *(Phase 6)* AI Studio |
| Network | Page Network, Accounts, Upload-Post |
| Admin | Team |

The group headings are the only addition; collapsing them is not needed at this size.

### 3.3 Centralized operations overview (R3)
A single read-only page, `Operations`, that replaces the empty-feeling dashboard as the landing page. It is a **composition of existing and planned summaries, not a new data source**:

| Block | Answers | Source |
|---|---|---|
| System health strip | Are API, database, Redis and the workers up? | `LIVE_OPERATIONS_ARCHITECTURE.md` §5 |
| Needs attention | What is blocked and what do I do? (failed/stale publications, accounts needing reconnection, jobs that failed) | Publishing Center state counts, Page Network account states, job tables |
| In progress | What is running right now and how far along? | §7, from real job rows |
| Queue depth | How much is waiting per pipeline? | queue counts |
| Today | Scheduled, published, failed today | Publishing Center overview |

Rules: every block shows *when its data was read* (§6.4); an empty block says so in words ("Nothing is running") instead of showing a zero-width bar.

## 4. Visual language (R2)

*Minimal* means: few colors, no decoration, nothing that is not information or an action. *Premium* means: consistent spacing, restrained motion, precise typography, no visual noise.

| Aspect | Rule |
|---|---|
| Color | background / surface / border / foreground / muted plus **one** accent. Status colors only for status, never for decoration. No gradients, no shadows as decoration; separation is by `border` and spacing. |
| Typography | Inter. Page title 20 px semibold; card title 14 px semibold; body 14 px; secondary 12 px `muted`; section label 12 px uppercase, wide tracking, `muted`. Numbers in stat tiles 24 px semibold. |
| Spacing | 4 px scale; card padding 16; gap between cards 16; page padding 32. |
| Density | Tables and lists are dense and scannable; whitespace goes between groups, not inside rows. |
| Icons | Sparing; text labels first. Never an icon alone for an action that changes data. |
| Contrast | text on `background`/`surface` meets WCAG AA (the tokens above do: `muted` on `surface` ≈ 7.3:1). Status is never conveyed by color alone — always a word. |
| Light theme | not planned; `darkMode: "class"` stays dark. |

## 5. Page patterns

| Pattern | Used for | Rule |
|---|---|---|
| Overview | landing page of an area | stat tiles row → two-column cards → "needs attention" list |
| List | every collection | filter bar on top, dense table, pager, row → detail, status as chip |
| Detail | one record | title + chips, actions top-right, cards for profile / state / history |
| Form | create and settings | labels above inputs, a one-line hint under every non-obvious field, one primary button |
| Empty state | no data | one sentence saying what this is and the next step, with a link |
| Banner | page-level notice | `info` (blue), `warn` (amber), `error` (red), `ok` (green); one sentence plus the fix |
| Narrow screens | all | single column; tables scroll inside their own wrapper (the content area must have `min-w-0`, fixed in Phase 4); 16 px gutters |

## 6. Progress (R4, R5, R12) — the binding rules

Implementation is future work; **these rules apply to every progress indicator ever added.**

### 6.1 Truthfulness rules
1. **Determinate only with a measured numerator and denominator**, both read from persisted job data or queue state. The label always states them ("3 of 8 targets published"); the percentage, if shown, is derived from them.
2. **Never invent a percentage.** No timers that creep forward, no fake easing toward 90 %, no "estimated" fill, no rounding up to look finished.
3. **When progress is not measurable, the bar is indeterminate** (a looping animation) and says what is happening and for how long, from real timestamps ("Rendering — started 2 min ago").
4. **A terminal state is a state, not a full bar.** Done shows a check and the result; failed shows the error panel (§8), never a red 100 %.
5. **No ETA** unless it is computed from at least N *real, completed* jobs of the same kind (N chosen when implemented; default: show none).
6. **Stage steppers** (e.g. Queued → Rendering → Ready) show only stages the system actually records, highlighting the current one from the real status.
7. **Stale data is labeled**, never presented as live (§6.4).

### 6.2 Which kind of bar, when
| Situation | Indicator |
|---|---|
| A count of finished items out of a known total (targets published, pages checked, rows synced out of rows known) | determinate bar + "x of y" |
| A job with a status but no internal progress (render, AI generation, provider upload) | indeterminate bar + stage label + real elapsed time |
| Waiting in a queue | "Queued — n ahead" only if the position is known from the queue; otherwise "Queued" with the queue's waiting count |
| A multi-step workflow | stage stepper, current stage from real state |
| Something has stopped | the error panel, no bar |

### 6.3 Motion (R5)
| Aspect | Rule |
|---|---|
| Determinate fill | CSS `width` transition of 200-300 ms, ease-out, **only between two real values**; no animation that advances without new data |
| Indeterminate | a 1.4 s looping highlight sliding across the track; no percentage text |
| Appear / disappear | 150 ms opacity fade; no bouncing, no parallax |
| `prefers-reduced-motion` | transitions off; indeterminate becomes a static striped track with the same text |
| Colors | bar fill `accent` (blue = in progress); done green; paused/stalled amber; failed uses the error panel |

### 6.4 Liveness
Every live block shows *Updated Ns ago*. If the last successful read is older than twice the refresh interval, the block switches to an amber **stale** chip and keeps the last numbers visible but dimmed — it never silently shows old numbers as current. Refresh mechanism: `LIVE_OPERATIONS_ARCHITECTURE.md` §6.

### 6.5 Accessibility of progress
`role="progressbar"` with `aria-valuemin/max/now` **only when determinate**; an indeterminate bar omits `aria-valuenow` and carries `aria-busy` plus the text label. Status changes are announced politely (`aria-live="polite"`), not on every poll.

## 7. Required progress views

Each view lists exactly what is measurable **today** (from the code at `110e637` and later), what is not, and what to show. Data sources are detailed in `LIVE_OPERATIONS_ARCHITECTURE.md` §4.

### 7.1 Campaign workflow visualization (R6)
A horizontal stepper on the campaign screen for the campaign's content, each step a **count from real rows**, never a guess:

`Content created → Media attached → Destinations chosen → Approved → Scheduled → Published` (with `Failed / Held` shown as a branch under the step where they occurred).

Numerator and denominator are the campaign's content / publication targets (the Publishing Center already derives 12 publication states from stored columns; a step is the sum of the states it contains). Measurable today. Pages in the campaign (Phase 4) appear as a count.

### 7.2 Media processing progress (R7)
Today: `VideoRenderJob` has `status` (PENDING / PROCESSING / SUCCEEDED / FAILED), `attempts`, `startedAt`, `completedAt`; FFmpeg's own percentage is **not** recorded and media duration is not extracted (TD-49). Therefore **today: stage + elapsed time, indeterminate while PROCESSING.** A real percentage needs (a) the source duration probed at upload (Phase 5, ffprobe) and (b) the worker persisting FFmpeg's `-progress` output time against that duration. Until both exist, no percentage is shown.

### 7.3 AI generation progress (R8)
Today: `ContentGenerationJob` has `status`, `attempts`, `startedAt`, `completedAt`, error code/message, and token usage and cost *after* completion. The provider reports no percentage. **Today: stage + elapsed time, indeterminate while running; usage shown only when finished.** For batches (N candidates, Phase 6): "2 of 4 candidates ready" is determinate because it counts finished rows.

### 7.4 Publishing queue progress (R9)
Measurable today: per-queue `waiting / active / delayed / failed` (BullMQ), per-publication stored state and attempt history, per-content "x of y destinations published", provider status (queued / processing / completed). **Show:** queue depth, per-content determinate "x of y published", per-publication stage (Queued → Publishing → Published, plus Failed/Stale with the reason). A provider upload in flight has no percentage: indeterminate with elapsed time.

### 7.5 Worker and Redis health (R10)
Measurable today: API `GET /api/health` → database and Redis reachability and the queue counts; worker `GET /health` (its own port) → ready only when every queue worker is connected. **Gap:** the dashboard cannot see the worker's liveness (the worker's endpoint is on a separate port and nothing records a heartbeat). The proposed fix is in `LIVE_OPERATIONS_ARCHITECTURE.md` §5. Show: API, Database, Redis, Workers, each ok / degraded / down with the last check time, and "queue backlog growing" only from real counts over time.

## 8. Errors that help (R11)

Every error the person can see is built from four parts, always in this order:

| Part | Example |
|---|---|
| What happened (plain words) | "Instagram refused the upload." |
| Why, if known (from a real error code, never guessed) | "The account's authorization expired." |
| What to do, as a button or link where possible | "Reconnect it in Upload-Post, then Sync now." → `Open Upload-Post` |
| Detail on demand (collapsed): code, attempt number, time, request id | `PROVIDER_REAUTH_REQUIRED · attempt 2 · 14:05` |

Rules: never show a raw stack trace, SQL or provider payload; never "Something went wrong" when a code exists (the API already returns `ERROR_CODES` and structured `details`); when no remedy is known, say so and name who to ask; one error panel component, used everywhere; field errors sit under the field, page errors in a `Banner`; the Publishing Center's `explainError` and the runbook tables (`PUBLISHING_OPERATIONS.md` §3-4) are the vocabulary to reuse.

## 9. Implementation status

| Item | Status |
|---|---|
| Tokens, Card/Stat/Banner/Chip/Pager, state badges, filter bar | **implemented** |
| Publishing Center and Page Network overviews, account/state chips, actionable validation messages | **implemented** |
| Sidebar grouping, Operations landing page | designed, **not built** |
| Progress components (bar, indeterminate, stepper), stale chip, error panel component | designed, **not built** |
| Campaign workflow stepper | designed, **not built** (data exists) |
| Media / AI progress | designed; real percentages **blocked** on ffprobe (Phase 5) and worker progress recording; stage + elapsed time only until then |
| Worker liveness, live refresh | designed, **not built** (`LIVE_OPERATIONS_ARCHITECTURE.md`) |

Out of scope here: any module of Phases 5-9 itself (Media Packs, Text Library, Format Engine, AI Studio, Creator portal, Analytics).
