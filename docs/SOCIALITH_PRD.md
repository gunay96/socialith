# Socialith — Product Requirements (Music Marketing & Content Operations Platform)

Status: **draft for owner approval**. This PRD *extends the existing application*; it
is not a rewrite. For every module it states what already exists (see PROJECT_AUDIT.md)
so the roadmap reuses it.

## 1. Product statement

Socialith is an operations platform for music marketing teams: plan a release
campaign, assemble approved media and copy, produce **original, page-appropriate**
content variations, route them through approval, publish and schedule through
authorized accounts (primarily via Upload-Post), and measure results — in one
dashboard, with a clear audit trail.

## 2. Guardrails (non-negotiable product rules)

1. **No artificial engagement.** No fake likes/comments/follows/views, no engagement
   pods, no auto-DM/auto-comment, no reposting-to-boost. Upload-Post endpoints for comments,
   DMs, AutoDM, reposts, ads are **out of scope** and must not be wired into the product.
2. **No repetitive mass distribution.** The same asset must not be blasted unchanged
   across many pages. The Content Format Engine must produce meaningfully different variations
   per page (copy, cut, format), the system enforces per-page/day caps and a minimum
   variation-distance check, and humans approve before anything is published.
3. **Authorized accounts only.** Every publishing account belongs to the organization or an
   onboarded creator who granted access; creators can see/revoke their connections.
4. **Honest labelling.** Platform AI-disclosure flags (e.g. Upload-Post `is_ai_generated`) are set
   when content is AI-generated; platform limitations are shown in the UI, not hidden.
5. **Approval before publish** is the default for every module that generates content.

## 3. Personas & roles

Owner, Admin, Editor, Viewer (**exist today**), plus new: **Approver** (can approve/reject
content for assigned pages/groups), **Creator** (external; sees only own briefs, media packs,
assignments, and earnings-neutral status; scoped to own accounts). Role changes must keep the
existing hierarchy tests green.

## 4. Modules

Legend for "Today": ✅ exists · 🟡 partial · ❌ none.

### A. Existing functionality to preserve — ✅
Login/session/RBAC/invitations/password reset, Dashboard, Accounts (OAuth connect), Campaigns,
Content (+variations, assets, targets, schedule, publish-now, retry), Sounds, Team, analytics
sync scaffolding, platform-capability matrix, audit logs, rate limits. **Acceptance:** all 262
tests stay green through every phase; no destructive schema change.

### B. Artist & Music Catalog — 🟡 (`Sound` only)
Entities: Artist (profile, links, brand notes), Release (single/EP/album, date, cover), Track
(ISRC, duration, audio/preview asset, lyrics, mood/genre tags, `externalSoundId` per platform).
`Sound` evolves into Track-platform references rather than being deleted.
**Acceptance:** create artist → release → tracks; link tracks to campaigns; platform sound ids
stored per platform; catalog search.

### C. Campaign Manager — 🟡 (`Campaign` is a lightweight container)
Extend with: artist/release/track links, goals, budget-free planning window, target groups,
brief, deliverables checklist, status workflow, campaign-level calendar and performance roll-up.
**Acceptance:** one campaign targets many pages/creators; all its content/publications/metrics
visible in one view.

### D. Media Pack Manager — ❌ (`ContentAsset` is per-content)
Reusable, versioned packs of approved clips/images/audio/cover art with usage rights, expiry,
and licensing notes; assignable to campaigns and page groups; direct-to-R2 upload with validation
(codec/duration/aspect/size) and generated thumbnails/previews.
**Acceptance:** upload a 500 MB pack asset without API memory spike; assign pack to a group;
rights-expired assets blocked from publishing.

### E. AI Content Studio — 🟡 (caption/hashtag job exists)
Prompted generation conditioned on artist, track, campaign brief, page style profile and recipe;
multiple candidate variations; moderation/brand-safety filter; human edit; one-click send to
approval. **Acceptance:** generate N candidates for a page; AI-generated flag recorded; every
candidate stored with prompt provenance.

### F. Creator Management & Creator Portal — ❌
Creator records (contact, platforms, rate card optional, status), invitation flow reusing the
existing Invitation machinery (requires real email, TD-06), portal with briefs, media packs,
submission upload, approval status, consent/connection management. **Acceptance:** creator logs
in, sees only own assignments, submits content, cannot see other creators or pages.

### G. Publishing Center — 🟡 (queue pipeline, no provider layer)
Unified provider-keyed publishing (Upload-Post first, native providers alternative), per-target
status, retries, scheduled and immediate publish, failure inbox, duplicate protection, publish
calendar. **Acceptance:** schedule 20 targets across 3 platforms; each ends in a terminal state
with a PublishAttempt trail; no duplicates after worker restart.

### H. Analytics Center — 🟡 (snapshots + dashboard tiles)
Aggregated provider analytics per post/page/group/campaign/artist, with freshness indicators and
honest "unavailable" states; export. **Acceptance:** campaign view shows views/likes/comments/shares
trend from `PostMetricsSnapshot`, source and `fetchedAt` visible.

### I. Page Network Manager — ❌
`ManagedPage` = a thematic publishing page (Motivation, Football, Humor/Memes, Relationships, custom)
**or** a Creator-owned presence — explicitly typed so thematic pages and individual creators are never
conflated. Each page has: editorial identity (name, voice, do/don't), style profile, content
requirements (formats, length, hashtags policy, posting cadence), authorized publishing accounts
(→ provider accounts), owner/approver users, status.
**Acceptance:** create a Football page with a style profile and 2 authorized accounts; assign it
to a group; only authorized accounts selectable when publishing to it.

### J. Content Format Engine — ❌ (FFmpeg is thumbnail-only)
Declarative formats (e.g. lyric-caption short, quote card, split-screen, text-over-clip) rendered by the
worker (FFmpeg) into page-appropriate originals with previews and approval. Uses export presets that
already exist but are unused. **Acceptance:** same source + two page profiles → two visibly distinct
renders with previews; render recorded as `VideoRenderJob`.

### K. Text Library — ❌
Org-scoped libraries of captions, hooks, quotes, CTAs, hashtag sets with tags, language, usage rules,
usage counters and cool-downs (to prevent repetition); full-text search; assignable to page groups.
**Acceptance:** an item cannot be reused on the same page within its cool-down.

### L. Content Recipe Builder — ❌
A recipe = format + media-pack selection rule + text-library selection rule + AI prompt template +
target page group + schedule rule + approval rule. Produces *drafts* (never auto-publishes).
**Acceptance:** run recipe → N drafts in the approval queue, each reproducible from recipe version.

### M. Page Category & Page Group Management — ❌
Categories (seeded: Motivation, Football, Humor/Memes, Relationships + custom) and Groups (arbitrary
collections of ManagedPages) with assignment of media packs, text libraries, recipes and permissions at
group level. **Acceptance:** assigning a media pack to a group makes it available to every page in the group.

### N. Upload-Post provider (cross-cutting, core)
Detailed in UPLOAD_POST_INTEGRATION.md: encrypted API key, profile sync, account↔page mapping,
upload/schedule/status/analytics through the provider, configurable plan capacity (no hard-coded 225).

## 5. Cross-cutting requirements

- Org-scoped multi-tenancy everywhere; every new table carries `organizationId`.
- Audit log entries for approvals, publishes, credential changes, role changes.
- Rate limits and per-page daily caps as enforced settings (guardrail 2).
- Observability: publish success rate, provider error rates, queue depth.
- Accessibility/i18n: UI language configurable (org already has `language`/`timezone`).

## 6. Non-goals (v1)

Paid ads management, comment/DM automation, follower growth tools, any engagement automation,
billing/subscriptions for end customers, a public marketplace.

## 7. Open questions for the owner

1. Database engine (PROJECT_AUDIT §1.4) — recommendation: PostgreSQL on a VPS.
2. Is Upload-Post the *only* production publisher at launch (native TikTok/IG/YT kept dormant)?
3. Creator compensation/contract tracking — in or out of scope?
4. Languages for UI and AI output (Turkish/English)?
5. Maximum pages/accounts at launch (drives provider capacity configuration, not code limits).
