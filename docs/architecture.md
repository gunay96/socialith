# Socialith — Architecture (Phase 01 + Phase 02A/02B/02C)

This document tracks architecture decisions as they are made, phase by
phase, per the build specification. It covers what Phase 01 (project
foundation) delivered, and Phase 02's three completed stages: 02A
(backend authentication core), 02B (team management + invitations), and
02C (password reset). See "Phase 02 status" below for the up-to-date
implemented/not-implemented split, and "Production package resolution"
below for the post-02C build-architecture fix that makes `apps/api` and
`apps/worker`'s compiled output actually runnable. Frontend pages beyond
the Phase 01 placeholder are **not** built yet. Later phases append to
this file rather than replacing it.

## Monorepo layout

```text
socialith/
├── apps/
│   ├── web/       Next.js 14 (App Router) + TypeScript + Tailwind
│   ├── api/       Express + TypeScript REST API
│   └── worker/    BullMQ worker (Node + TypeScript)
├── packages/
│   ├── database/  Prisma schema, client, migrations, seed
│   ├── auth/      Password hashing (scrypt, node:crypto only), secure tokens, RBAC — used by database (seed) and, from Phase 02's API work onward, apps/api
│   ├── types/     Shared cross-app TypeScript types (API envelope, error codes)
│   ├── config/    Zod-validated environment loader
│   ├── ui/        Shared component library (placeholder — Phase 03)
│   └── video-engine/  FFmpeg rendering pipeline (placeholder — Phase 07)
├── docs/
├── .github/workflows/ci.yml
└── docker-compose.yml
```

Package manager: **pnpm** workspaces. Task runner: **Turborepo**.

## Why this stack

- **Next.js / Express / BullMQ split**: keeps the request path (API) free of
  long-running work (rendering, publishing) per spec §27 — nothing blocks an
  HTTP request while a video renders or a post publishes.
- **Prisma over raw SQL**: schema-as-code with generated types and a
  migration history required by spec §69 ("never manually modify production
  schema without migrations").
- **Redis + BullMQ**: single queueing technology for all six queues defined
  in spec §35 (`content-generation`, `video-render`, `publishing`,
  `analytics-sync`, `notifications`, `cleanup`), rather than one-off job
  runners per feature.
- **Workspace packages for types/config**: the API and worker both need the
  same env validation and response shape; duplicating them invites drift.

## Database

### Phase 01 tables (migration `20260101000000_init`)

- `organizations` — multi-tenant root, `timezone` defaults to
  `Europe/Istanbul`, all timestamps stored in UTC (spec §11, §58).
- `users` — `role` (`OWNER`/`ADMIN`/`EDITOR`/`VIEWER`) and `status` enums per
  spec §9/§12.
- `audit_logs` — present from Phase 01 so every phase from here on can log
  into it immediately, per spec §15 Rule ("every destructive action must be
  auditable").

### Phase 02 additions (migration `20260210000000_phase02_auth`)

A second, separate migration — the Phase 01 migration was **not** edited —
adds only what Phase 02's schema needs:

- `users.session_version` (`INTEGER NOT NULL DEFAULT 0`) — bumped on
  password reset (and available for a future "log out everywhere" action)
  so every existing session for that user can be invalidated by comparing
  a value embedded in the session against this column, instead of having
  to enumerate and delete sessions individually.
- `invitations` — invite-only account creation (spec §9/§53: "public
  registration OLMAYACAK"). Stores `token_hash` (unique), never the raw
  token; `expires_at`; `accepted_at` (null until accepted, making
  acceptance naturally single-use); `invited_by_id` (`ON DELETE RESTRICT`
  — an inviter can't be deleted while their invitation record still
  exists); `organization_id` (`ON DELETE CASCADE`).
- `password_reset_tokens` — same "hash only" rule as invitations, plus
  `used_at` to make a already-consumed token unusable even before it
  expires. `user_id` is `ON DELETE CASCADE`.

### Phase 02B addition (migration `20260215000000_add_user_removed_status`)

A third migration adds one enum value: `UserStatus.REMOVED`. Needed
because `DELETE /api/team/:userId` (team management) can't be a hard
`prisma.user.delete()` — `invitations.invited_by_id` has
`ON DELETE RESTRICT`, so removing a user who has ever sent an invitation
would fail at the database level, and even if it didn't, deleting the row
would erase audit history tied to that user. `REMOVED` is a distinct
status from `DISABLED`: a `DISABLED` member still shows in `GET /api/team`
so an admin can re-enable them; a `REMOVED` member does not, and their
email becomes eligible for a fresh invitation (which reactivates the same
row rather than trying to create a second `User` with that email, blocked
by the unique constraint). `requireAuth`'s existing `status === "ACTIVE"`
check already rejects `REMOVED` sessions with zero code changes, the same
way it already rejected `DISABLED` ones.

Only the schema and migration exist so far — see "Phase 02 status" below
for what still needs to be built on top of them.

Remaining domain entities (`social_accounts`, `platform_connections`,
`campaigns`, `content`, `publishing_jobs`, `analytics_snapshots`, etc., per
spec §10) are introduced in the phases that own them so each phase ships a
reviewable, working slice instead of one large upfront migration.

### Migration verification status

**All three migrations were hand-written, not generated by
`prisma migrate dev` against a live database** — no database is reachable
in the environment this was built in. Each was checked field-by-field
against `schema.prisma` (types, defaults, nullability, enum values,
unique/index names, and foreign-key actions), and all three are
internally consistent with each other and with the current schema as of
this writing — but "checked by hand" is not the same guarantee as a
Prisma-generated, DB-verified migration. **Run `prisma migrate dev` in a
real environment before relying on any of them** — it should produce an
empty diff if all three are correct; if it doesn't, trust the real Prisma
output over these files.

## Auth package (`@socialith/auth`) — Phase 02 groundwork

A dependency-light workspace package with no framework or database
coupling, so its rules are unit-testable in isolation:

- `password.ts` — scrypt hashing (`hashPassword`/`verifyPassword`, Node's
  built-in `node:crypto`, no native dependency — switched from Argon2id
  during the shared-hosting migration once `argon2`'s prebuilt binary
  turned out to require GLIBC_2.34, unavailable on Güzel Hosting's shared
  cPanel and uncompilable there either). Versioned, self-describing
  format (`scrypt$v1$N$r$p$salt$hash`) with explicit memory-hard cost
  parameters recorded per-hash, so a future cost bump never breaks
  verification of hashes created under the old parameters — same
  "explicit over library defaults" reasoning as the Argon2id version had.
  `verifyPassword` never throws on a wrong password (only on a malformed
  hash) and returns `false` either way, so callers can't accidentally
  leak *why* a login failed.
- `tokens.ts` — `generateSecureToken` (256-bit, URL-safe) and `hashToken`
  (SHA-256) for invitation/password-reset links: the raw token is handed
  to the user exactly once and never persisted, only its hash is, per the
  spec's "invitation süresi olsun... tek kullanımlık olsun" and the
  equivalent password-reset requirement. `safeCompareHashes` does a
  constant-time comparison for any code path that compares hashes outside
  a DB `WHERE` clause.
- `rbac.ts` — pure role-hierarchy functions (`hasMinimumRole`,
  `canManageTeam`, `canAssignRole`, `canActOnMember`) mirroring the
  `UserRole` enum as a plain string union (kept dependency-free rather than
  importing `@socialith/database`). Encodes two rules not obvious from the
  role list alone: only an OWNER can grant the OWNER role, and an ADMIN can
  never act on (change the role of / disable / remove) an existing OWNER.
- Depended on today by `packages/database` (the seed script hashes its dev
  password with `hashPassword`) and by `apps/api` (login/session/RBAC —
  see "Backend authentication core" below).
- Dependency direction: `database → auth` and `api → auth`, and `auth`
  depends on nothing outside this workspace at all — `password.ts` uses
  only Node's built-in `node:crypto` — no cycle.

## Backend authentication core (Phase 02, stage 1 of N)

Implements login, logout, `/me`, session handling, and the RBAC/audit
foundations. Deliberately **not** in this stage: invitation API, team
management API, forgot/reset-password, email sending, and all frontend
pages — those are later Phase 02 stages.

**Layering** (`apps/api/src/`): `routes/` (path → middleware chain) →
`controllers/` (parse request, call service, shape response) →
`services/` (business logic, e.g. `authenticateWithPassword`) →
`repositories/` (the only files that call `prisma` directly) →
`middleware/` (`requireAuth`, `requireMinimumRole`, rate limiting) →
`validation/` (zod schemas) → `lib/` (session config). No business logic
lives in a route file.

**Endpoints** (mounted under `/api` in `app.ts`):
- `POST /api/auth/login` — `authenticateWithPassword` looks up the user,
  verifies the password with `@socialith/auth`, and rejects a non-`ACTIVE`
  user. On success: `req.session.regenerate()` (new session ID, preventing
  session fixation from a pre-set cookie), stores `userId` +
  `sessionVersion` in the session, updates `lastLoginAt`, writes a
  `LOGIN_SUCCESS` audit row, returns the safe user projection.
- `POST /api/auth/logout` — behind `requireAuth`. Destroys the session,
  clears the cookie, writes a `LOGOUT` audit row.
- `GET /api/auth/me` — behind `requireAuth`. Returns `req.user` (the safe
  projection `requireAuth` already attached) — nothing further is read
  from the database for this endpoint.

**Session design**: server-side sessions (`express-session`) backed by
the app's existing Redis connection via `connect-redis` — no new
datastore, no auth tokens in `localStorage`. Cookie: `HttpOnly`;
`Secure` only when `NODE_ENV=production`; `SameSite=Lax` (the web app and
API are same-site — subdomains of one registrable domain in production,
`localhost` in dev — so a Lax cookie is still sent on the frontend's
credentialed cross-origin fetches, while still refused on genuinely
cross-site requests); `rolling: true` (sliding 7-day expiration, renewed
on activity, not a fixed 7-day-from-login cliff).

**Session invalidation** uses the existing `User.sessionVersion` column
rather than a new table: the value is snapshotted into the session at
login, and `requireAuth` re-fetches the user fresh on *every* request and
compares it to the live column. A mismatch (or a disabled/missing user)
destroys the session server-side and returns 401 — this is also how a
role change or account disable takes effect on the very next request
instead of waiting for the next login. (`sessionVersion` isn't bumped
anywhere yet in this stage — that starts with password reset, in a later
Phase 02 stage — but the invalidation mechanism itself is live and
tested.)

**Why no CSRF middleware yet**: `SameSite=Lax` + the API's strict
single-origin CORS check (`app.ts`, no wildcard, no reflected origins) +
JSON-only request bodies (which force a CORS preflight the browser won't
run for a same-site form post) together rule out the classic cross-site
form-submission CSRF this would otherwise need to defend against. This
gets revisited if a later stage adds a request path that doesn't fit that
description (e.g. a state-changing `GET`, or a route that accepts
`multipart/form-data`).

**Rate limiting**: `createRedisRateLimiter` (in
`middleware/rate-limit.ts`) is a small factory over `express-rate-limit` +
`rate-limit-redis`, backed by the same Redis connection as sessions — no
new datastore. `createLoginRateLimiter` applies it to login only, keyed
on IP **and** the attempted email together (`buildLoginRateLimitKey`),
so a single heavily-NATed office IP can't get every account behind it
throttled by one bad actor, while a credential-stuffing sweep against one
account is still caught. The factory is generic so a forgot-password or
invitation-creation limiter can reuse it later without touching this
file.

**RBAC foundation**: `middleware/rbac.ts`'s `requireMinimumRole(role)`
wraps `@socialith/auth`'s `hasMinimumRole` as Express middleware — 401 if
unauthenticated, 403 if under the required role, otherwise `next()`. It
is not yet mounted on any route (there's no protected business endpoint
in this stage to mount it on), but it's fully implemented and tested in
isolation. The team-specific rules (`canActOnMember`, `canAssignRole` — an
ADMIN can never act on an OWNER, only an OWNER can grant OWNER) already
exist in `@socialith/auth` and are wired into the team API in a later
Phase 02 stage.

**Organization isolation**: every authenticated request gets
`req.user.organizationId` from a fresh database read (never from a
client-supplied value), via `requireAuth`. There is no cross-organization
data endpoint yet to isolate — `/me` only ever returns the caller's own
record — but this is the mechanism every future org-scoped query is
expected to filter by.

**Known limitation — `LOGIN_FAILED` for an unknown email isn't an
`AuditLog` row.** `audit_logs.organization_id` is `NOT NULL`, and an email
that matches no user has no organization to attach a row to. Writing it
under some placeholder/system organization would misattribute the event
into a real tenant's audit trail, which is worse. This case is logged via
the structured `pino` logger instead (visible operationally, just not in
any organization's audit view). `LOGIN_FAILED` for a *wrong password* or
a *disabled account* — where a user record does exist — writes a real
audit row as normal. Revisit this if a later stage adds a nullable
`organizationId` or a separate cross-org security log for
pre-authentication events.

**Timing safety**: the login path always performs a full scrypt
verification, win or lose. When the email doesn't match any user, it
verifies against a real scrypt hash of a freshly-generated random token
(computed once per process, cached) instead of skipping straight to a
rejection — so an unknown-email attempt costs the same wall-clock time as
a wrong-password attempt, and the two produce byte-identical response
bodies (see `apps/api/src/routes/auth.test.ts`).

## Team management + invitations (Phase 02B)

Implements the six team endpoints, invitation creation/preview/acceptance,
and the email abstraction. Deliberately **not** in this stage:
forgot/reset-password, email sending to a real provider, and all frontend
pages.

**Endpoints** (mounted under `/api` in `app.ts`, alongside the auth
router):
- `GET /api/team` — behind `requireAuth` only (every role, including
  VIEWER, can view). Returns `{ members, pendingInvitations }`; members
  are the exact safe fields spec §2 lists (selected at the query level in
  `team.repository.ts`, not filtered after the fact), `REMOVED` members
  excluded. `pendingInvitations` never includes `tokenHash`.
- `POST /api/team/invitations` — behind `requireAuth` +
  `requireMinimumRole("ADMIN")`. `role: "OWNER"` is rejected by the zod
  schema itself (`invitableRoleSchema`), not just by service logic — a
  malformed/tampered body can never reach `invitation.service.ts` with
  that value.
- `GET /api/team/invitations/:token` — **not** behind `requireAuth`: the
  invitee has no session yet, and the token itself (delivered only via
  the invitation email) is the credential. Read-only preview, no side
  effects.
- `POST /api/team/invitations/:token` — also public for the same reason.
  Accepts `{ name, password }` (12+ characters — this is the one place a
  password is actually *set*, so the real policy lives here, not at
  login), performs the transactional acceptance, and establishes a
  session exactly like login does.
- `PATCH /api/team/:userId/role`, `POST /api/team/:userId/disable`,
  `POST /api/team/:userId/enable`, `DELETE /api/team/:userId` — all
  behind `requireAuth` + `requireMinimumRole("ADMIN")`, then further
  gated per-target by `@socialith/auth`'s `canActOnMember`/`canAssignRole`
  (unchanged from Phase 02A — this stage is the first to actually call
  them). `disable` and `DELETE` additionally reject the actor targeting
  their own `userId` (400) before even loading the target.

**Organization isolation for a specific member**: `findOrganizationMemberById(organizationId, userId)`
scopes the lookup itself (`WHERE id = ? AND organization_id = ?`), so a
`userId` belonging to another organization simply doesn't match and
every one of the four mutating endpoints returns 404 — never 403 — for
it. This is deliberate: a 403 would confirm the ID exists somewhere; 404
doesn't.

**"One outstanding invitation per email per organization"** (the rule
noted on the `Invitation` model in `schema.prisma`) is enforced in
`invitation.service.ts`'s `createInvitation`, not by a database
constraint: before creating a new invitation, it looks up any existing
unaccepted, unexpired one for that email+org and revokes it (pushes
`expires_at` into the past) rather than deleting it or allowing a second
valid one to exist alongside it.

**Email uniqueness is global, not per-organization** (`users.email` is
`@unique` with no organization scoping), which shapes both invitation
creation and acceptance:
- Creating an invitation for an email that already belongs to a
  non-`REMOVED` user — in *this* org or a *different* one — is rejected
  (409 `CONFLICT`) before any invitation row is written.
- A `REMOVED` user's email is treated as free: inviting it is allowed,
  and accepting that fresh invitation **reactivates the same row**
  (updates name/password/role, sets `status: "ACTIVE"`) rather than
  attempting `user.create()` with a duplicate email, which the unique
  constraint would reject anyway.
- If, despite the creation-time check, acceptance still finds an existing
  *active* user for the invitation's email in a *different* organization
  (a race, or a user added some other way), it's rejected with a clear
  409 rather than silently reassigning them — this schema has no
  multi-organization membership model, so there is nothing safe to do
  but refuse.

**Acceptance runs inside one `prisma.$transaction`**: re-checking the
invitation is still outstanding, creating-or-reactivating the user, and
marking the invitation accepted all happen together — a crash mid-flow
can't leave an accepted invitation with no user, or a new user whose
invitation is still technically valid for reuse. Establishing the actual
session happens *after* the transaction commits (session state lives in
Redis, not Postgres, so it was never part of the atomic unit).

**The raw invitation token never touches a log or an audit row.** Only
`tokenHash` is persisted (`@socialith/auth`'s `hashToken`, reused
unchanged from Phase 02A groundwork); `INVITATION_CREATED` and
`INVITATION_ACCEPTED` audit metadata carries only `{ email, role }`. The
one place the raw token appears in plaintext at all is the invitation
email itself (`lib/email/email.service.ts`) and, outside production
only, the `devAcceptUrl` field in `POST /api/team/invitations`'s response
— see "Email abstraction" below.

**Email abstraction** (`lib/email/email.service.ts`): an `EmailService`
interface — `sendInvitation` (this stage) and `sendPasswordReset` (Phase
02C) — and a `ConsoleEmailService` implementation that logs the
would-be email via `pino` instead of sending anything — there is no real
provider connected, and this is not disguised as one. Selection goes
through `getEmailService(logger, provider)`, where `provider` comes from
`EMAIL_PROVIDER` (`@socialith/config`, `"console"` is the only supported
value today) — wiring in a real provider later means adding a `case` to
that one function and a value to that one enum, nothing else moves.
Because there's no real provider, `createInvitation`'s response includes
a `devAcceptUrl` field (the full accept URL, raw token included) whenever
`NODE_ENV !== "production"`, so a developer can exercise the invitation
flow without reading server logs; in production this field is omitted.
**Password reset does not follow this pattern** — see below for why.

**Session reuse**: `login` (Phase 02A) and `acceptInvitation` (this
stage) both need to regenerate a session and write the same four fields
to it. Those two helpers (`regenerateSession`, `destroySession`) were
private to `auth.controller.ts` in Phase 02A; they and a new
`establishSession` helper were moved to `lib/session.ts` in this stage so
both call sites share one implementation instead of duplicating it.
`auth.controller.ts` was updated to import them from there — its
behavior is unchanged, only where the code lives.

## Password reset (Phase 02C)

Implements `POST /api/auth/forgot-password` and
`POST /api/auth/reset-password`. Deliberately **not** in this stage: any
frontend pages, and a real email provider (see the email abstraction
above — unchanged, just extended).

**Endpoints** (mounted under `/api/auth`, not behind `requireAuth` — the
entire point is helping someone who currently can't log in):
- `POST /api/auth/forgot-password` — `requestPasswordReset` always
  resolves; it never signals back whether the email matched an eligible
  account. The controller returns the exact same 200 body every time — a
  known email, an unknown one, and a `DISABLED`/`REMOVED`/`INVITED`
  account are all indistinguishable from the response alone (tested). A
  syntactically malformed email still gets `400 INVALID_REQUEST`, same
  as every other endpoint's validation failure — that's a distinct
  concern from account eligibility (an invalid address was never going
  to match a real account either way, so responding differently to it
  reveals nothing about which real emails exist).
- `POST /api/auth/reset-password` — validates the token (hash lookup,
  not-expired, not-yet-used) and the target user (still `ACTIVE`) inside
  one `prisma.$transaction` together with the password update and
  marking the token used, then bumps `sessionVersion`. Returns a plain
  success body — **no session is established**, unlike login/invitation
  acceptance: the point of a reset is "logged out everywhere, log in
  again with the new password," not an automatic new session.

**Why forgot-password's response can never vary, not even in
development.** Invitation creation is authenticated and admin-only, so
its `devAcceptUrl` convenience field carries no enumeration risk.
Forgot-password is public and unauthenticated — any field that appears
only sometimes (present for real accounts, absent otherwise) would
itself be the enumeration signal the rest of the design is protecting
against. So the reset link is visible in development only via
`ConsoleEmailService`'s log line, never through the API response, in any
environment.

**Timing safety** mirrors login's approach (see Phase 02A above) but
applies it to token generation instead of password verification: a real
`generateSecureToken`/`hashToken` pair is computed for *every*
`forgot-password` call, whether or not the email turns out to be
eligible, so an unknown-email request and a real-account request cost
about the same regardless of what happens after. There is no password
check on this path (there's no password to verify against yet), so
there's no Argon2 dummy-hash step here the way login has one.

**Token model reused, not recreated**: `PasswordResetToken` already
existed from the Phase 02 groundwork stage (`tokenHash` unique, hash-only
storage, `expiresAt`, nullable `usedAt` for single-use tracking,
`userId` indexed, cascade-deleted with the user) and already satisfied
every Phase 02C requirement — reviewed field-by-field against the spec
before writing any code. **No new migration was created.** Reset tokens
get a 1-hour expiry (`RESET_TOKEN_TTL_MS`), shorter than an invitation's
7 days, since this is a self-service action the requester triggers and
should act on promptly, not something someone else is waiting on.

**Re-checked at consumption time, not just at issuance**: `resetPassword`
re-verifies the target user is still `ACTIVE` inside the transaction —
if an admin disables/removes the account in the window between the
reset request and the reset attempt, the token stops working even
though it hasn't expired or been used yet.

**sessionVersion invalidation** uses the exact same mechanism
`requireAuth` already checks on every request (Phase 02A) — no new
invalidation path was built. `repositories/user.repository.ts`'s
`updatePasswordAndInvalidateSessions` bumps `sessionVersion` via Prisma's
atomic `{ increment: 1 }` in the *same* write as the password hash
update, rather than a separate read-then-write, so there's no race
between reading the old value and writing the new one. This was verified
end-to-end in `routes/auth.test.ts`, not just at the unit level: log in,
reset the password, confirm the pre-reset session's `/me` now returns
401, then confirm a fresh login succeeds only with the *new* password.

**Password policy shared, not duplicated a third time**: the 12-character
minimum (introduced for invitation acceptance in Phase 02B) now lives in
`validation/password-policy.ts` as `passwordPolicySchema`, imported by
both `team.validation.ts` (invitation acceptance) and the new
`password-reset.validation.ts` (reset). `team.validation.ts` was edited
to import the shared schema instead of keeping its own inline copy —
behavior is unchanged, this only removes a duplicate that would
otherwise be free to drift.

**Rate limiting**: two new limiters via the existing
`createRedisRateLimiter` factory (Phase 02A) — no new rate-limiting
mechanism. `createForgotPasswordRateLimiter` reuses login's exact
IP+email `buildLoginRateLimitKey`, with a looser cap (a legitimate user
might retry a mistyped email a few times). `createResetPasswordRateLimiter`
is IP-only (there's no email in this request, only a token) — described
as "token brute-force protection" in the spec, though the token itself
(256-bit random) is already computationally infeasible to guess; this is
cheap defense in depth against a scripted attempt, not the primary
defense.

**Audit logging**: `PASSWORD_RESET_REQUESTED` and
`PASSWORD_RESET_COMPLETED`, both carrying only `{ organizationId, userId,
action }` — no `metadata` object at all, so there's nothing for the
existing password/token/secret/hash/credential metadata filter
(`audit-log.repository.ts`, unchanged) to even need to catch on this
path. An unknown-email `forgot-password` call writes no audit row at
all, for the same reason login's unknown-email case doesn't (see Phase
02A's "Known limitations": `audit_logs.organization_id` is `NOT NULL`,
and there's no organization to attach one to) — logged via `pino`
instead, at the same conservative level of detail (no email, no
distinguishing reason).

## Phase 02 status

**Implemented**: (02A) login, logout, `/me`, session middleware,
`requireAuth`, Redis-backed login rate limiting, `LOGIN_SUCCESS`/
`LOGIN_FAILED`/`LOGOUT` audit logging. (02B) the six team endpoints,
invitation creation/preview/acceptance, `requireMinimumRole` now actually
mounted on routes, the email abstraction, and
`INVITATION_CREATED`/`INVITATION_ACCEPTED`/`USER_ROLE_CHANGED`/
`USER_DISABLED`/`USER_ENABLED`/`USER_REMOVED` audit logging, plus the
follow-up OWNER self-role-change and last-owner-protection corrections.
(02C) forgot-password/reset-password, `PASSWORD_RESET_REQUESTED`/
`PASSWORD_RESET_COMPLETED` audit logging, the shared password policy,
and the extended email abstraction.

**Not implemented yet**: CSRF (deliberately — see above, revisit if the
request shape changes), email sending to a real provider, and all
frontend pages — those are later Phase 02 stages. See the README's
Phase 02 section for the up-to-date checklist and what was/wasn't
actually run.

## Task graph (Turborepo)

`lint`, `typecheck`, and `test` do **not** depend on `build` — they run
directly against source (via `tsc --noEmit`, `eslint`, and `vitest`/`tsx`,
none of which need compiled output). Only `build` depends on `^build`
(upstream packages' own build output), so the intended order is:

```text
lint / typecheck / test  (independent, no build required)
        ↓
      build
```

CI (`.github/workflows/ci.yml`) enforces this order explicitly as separate
sequential steps rather than relying on turbo's graph alone.

## Production package resolution (post-Phase-02C fix)

**The problem this fixes.** Through Phase 02C, every workspace package
(`packages/auth`, `config`, `database`, `types`, `ui`, `video-engine`)
had `package.json` `"main"`/`"types"` pointing directly at
`./src/index.ts`, and none of them had a `build` script. `apps/api` and
`apps/worker` compiled fine (`tsc -p tsconfig.json` only touches their
own `src/`), but their compiled `dist/*.js` files still contain the bare
specifiers they were written with (e.g. `import { ... } from
"@socialith/auth"` — TypeScript never rewrites import specifiers, it
only resolves them for type-checking). Running the actual production
command, `node dist/index.js`, would have Node's module resolver read
`@socialith/auth`'s `package.json`, find `"main": "./src/index.ts"`, and
try to load a `.ts` file directly — which plain `node` cannot parse.
This was never caught because CI runs `pnpm build` but never actually
executes `node dist/index.js` afterward, and the codebase's own
"Verification status" already flagged that `pnpm build` itself had never
been run in the authoring environment.

**The fix.** Every workspace package now has a real `build` script and
compiled output:

- `package.json`: `"type": "module"`, `"main": "./dist/index.js"`,
  `"types": "./dist/index.d.ts"`, and a `"build": "tsc -p tsconfig.json"`
  script (`packages/auth`, `config`, `types`, `ui`, `video-engine`).
  `"type": "module"` is new — Phase 02's groundwork deliberately omitted
  it because these packages were only ever consumed as TypeScript source
  (never loaded directly by `node`); now that `dist/*.js` is real,
  compiled ESM output that `node` loads directly, the package needs to
  declare that.
- `packages/database` and `apps/api`/`apps/worker` needed one extra
  wrinkle: each already used its single `tsconfig.json` for **both**
  `typecheck` (`tsc --noEmit`, no emit) and would otherwise have used it
  for `build` too. `packages/database`'s `tsconfig.json` also includes
  `prisma/seed.ts` (a `tsx`-run dev script, never meant to ship in
  `dist/`), and (see below) the `typecheck` config now resolves sibling
  `@socialith/*` packages straight to their source across the package
  boundary — which `tsc` refuses to *emit* (`TS6059: File is not under
  'rootDir'`) even though it's fine to *type-check*. So each of these
  three now has a **second**, build-only `tsconfig.build.json`
  (`extends` the base one, sets `rootDir`/`outDir`, and — for
  `apps/api`/`apps/worker`/`packages/database` — resets `paths` back to
  `{}`), and `"build"` points at that instead:
  `apps/api/tsconfig.build.json`, `apps/worker/tsconfig.build.json`,
  `packages/database/tsconfig.build.json` (which also narrows `include`
  to `["src"]`, dropping `prisma/seed.ts` from the compiled output).
- `apps/api/tsconfig.json`, `apps/worker/tsconfig.json`, and
  `packages/database/tsconfig.json` each gained a `compilerOptions.paths`
  entry mapping every `@socialith/*` package they import to that
  package's `src/index.ts` directly (e.g.
  `"@socialith/auth": ["../../packages/auth/src/index.ts"]`). TypeScript
  `paths` is a **resolution-only** construct — it changes what file `tsc`
  type-checks against, it never rewrites the emitted `import` specifier —
  so this has zero effect on what ships in `dist/`. What it *does* do is
  let `pnpm typecheck` and `tsx watch` (the `dev` script) resolve
  `@socialith/*` imports straight to source, so neither one requires the
  dependency packages to be built first. This preserves the existing
  "`lint`/`typecheck`/`test` don't depend on `build`" invariant (see
  "Task graph" above) instead of quietly breaking it. `apps/web/tsconfig.json`
  got the equivalent single entry for `@socialith/types`, merged into its
  existing `"@/*"` alias — harmless, since Next.js already resolves that
  import to source via `transpilePackages` today; the explicit alias just
  makes `tsc --noEmit` agree without needing `packages/types/dist` to
  exist.
- The build-only configs (`tsconfig.build.json`) deliberately do **not**
  carry that `paths` override forward — they reset it to `{}` — because
  at real build time `@socialith/*` must resolve exactly the way
  production `node` will resolve it later: through the dependency
  package's `package.json` `"main"` (→ its own `dist/index.js`), not
  through raw sibling source outside this project's `rootDir`. Turborepo's
  existing `"build": { "dependsOn": ["^build"] }` (unchanged — this was
  already correct, it just had nothing to build before) guarantees every
  `@socialith/*` dependency's `dist/` already exists by the time a
  dependent's own `build` runs, so this resolution never hits a missing
  file.
- No change was needed to `turbo.json` beyond what's described above
  (i.e. none at all) — `dependsOn: ["^build"]` was already exactly the
  right dependency declaration; it simply had no effect while packages
  had no `build` script to run.

**Net effect**: `node apps/api/dist/index.js` and `node
apps/worker/dist/index.js` now resolve every `@socialith/*` import to
real, compiled JavaScript (each dependency's `dist/index.js`), never to
a `.ts` source file — while `pnpm typecheck`, `pnpm test`, and `pnpm dev`
remain exactly as fast/independent as before (no package needs to be
built first for any of those). `apps/web` is unaffected: its own build
is `next build`, not `tsc`, and its `transpilePackages`/`paths` handling
of `@socialith/types` is unchanged in behavior.

**Still unverified** (no Node.js/npm/pnpm toolchain was available in the
environment this fix was written in — see "Verification status" in
README.md): that `tsc` actually accepts this `tsconfig.build.json` split
without a different error than the `TS6059` this was designed to avoid,
that `tsx watch` actually honors `compilerOptions.paths` the way its
documentation describes, and that the resulting `dist/index.js` files
genuinely run end-to-end against a real Postgres/Redis. This needs a
real `pnpm install && pnpm build && node apps/api/dist/index.js` run
before being trusted beyond "reviewed carefully."

## Build hygiene: test files never reach `dist/`

`tsconfig.base.json`'s `exclude` includes `**/*.test.ts` and
`**/*.spec.ts`, inherited by every `apps/*` and `packages/*` tsconfig
that doesn't define its own `exclude` (only `apps/web` does, and it
doesn't emit via `tsc` anyway — Next.js builds it). Before this, running
`pnpm build` on `apps/api` (or any package with `.test.ts` files) would
have compiled test files into `dist/` alongside the real source,
because the per-project tsconfigs only declared `"include": ["src"]`
with no test exclusion. That specifically mattered for
`apps/api/src/routes/team.test.ts`, which defines a test-only
`/test/login-as` Express route used to establish an authenticated
session in tests without going through the real login flow — it was
never imported by `app.ts`/`index.ts` so it could never actually run in
the shipped app, but it had no business being compiled into `dist/` at
all.

**Verified directly** (not just reasoned about): running the sandbox's
`tsc --listFilesOnly` against the real `apps/api/tsconfig.json` and
`packages/auth/tsconfig.json` confirms every `.test.ts` file — including
`routes/team.test.ts` — is absent from the resolved file list, while
every real source file is present. This only exercises TypeScript's own
file-discovery/`include`-`exclude` resolution, not real compilation, so
it needed no project dependencies to check for real, unlike almost
everything else in this README/doc that's marked unverified.

## API (Phase 01 scope)

- `GET /health` — reports API/database/redis reachability (spec §63).
  Returns `200` when all three are healthy, `503` otherwise, using the
  shared `ApiResponse<T>` envelope from `@socialith/types`.
- Centralized error handler: unhandled errors are logged server-side via
  `pino` and returned to clients as a generic `INTERNAL_ERROR` — no stack
  traces or internal messages leak to the client (spec §62).
- **CORS**: restricted to exactly one origin, resolved by
  `resolveAppOrigin()` in `@socialith/config`:
  - Development/test: `NEXT_PUBLIC_APP_URL` if set, else
    `http://localhost:3000`.
  - Production: `NEXT_PUBLIC_APP_URL` is **required** and validated to not
    be `localhost`/`127.0.0.1`/`::1` — the app fails to boot rather than
    silently falling back to a permissive or wrong origin.
  - The `cors` middleware uses a custom `origin` callback that only
    allows the exact resolved origin; requests with no `Origin` header
    (health checks, curl, server-to-server) are allowed through since
    they aren't subject to browser same-origin policy; any other origin
    is rejected and logged as a warning. There is no wildcard and no
    reflection of arbitrary request origins.
- Auth, campaign, content, publishing, and analytics routers are added in
  Phases 02, 06, 07, 08, and 09 respectively.

## Worker (Phase 01 scope)

- Connects to Redis via `ioredis` and exposes its own `/health` endpoint
  (separate port from the API, per spec §63 "worker should expose worker
  health").
- Ships one smoke-test queue/processor (`cleanup`) to prove the
  Redis↔BullMQ↔worker path works end-to-end. The five other queues are
  registered by name in `apps/worker/src/queues.ts` as a single source of
  truth; their processors are implemented by the phase that owns them.
- **No database dependency**: the worker does not import
  `@socialith/database` or hold a Prisma connection in Phase 01, because
  no current job needs Postgres. `@socialith/database` is intentionally
  kept as its own workspace package (not folded into the API) precisely so
  a later phase's processor (e.g. publishing-job status updates in Phase
  08) can add it back as a dependency and import `{ prisma }` without
  restructuring anything — see the comment at the top of
  `apps/worker/src/index.ts`.

## Web (Phase 01 scope)

- Next.js App Router shell with the dark theme tokens from spec §6
  (background `#0a0a0a`, surface `#141414`, Inter font, 12px radius) wired
  into Tailwind config.
- A single placeholder page — no login screen, sidebar, or dashboard yet.
  Those are Phase 02 (auth) and Phase 03 (dashboard shell + navigation).

## Environment configuration

All variables are declared in `.env.example` (spec §65) with empty/placeholder
values — nothing in this repository is a real secret. `@socialith/config`
validates only what Phase 01 actually boots with (`DATABASE_URL`,
`REDIS_URL`, ports, `SESSION_SECRET`, and `NEXT_PUBLIC_APP_URL` for CORS)
using `zod`, so a missing variable fails immediately at startup with a
clear message rather than surfacing as an obscure runtime error later.
`NEXT_PUBLIC_APP_URL` is optional in development/test and required
(non-localhost) in production — see the API section above. `EMAIL_PROVIDER`
(Phase 02C) is also actually validated — `z.enum(["console"]).default("console")`
— unlike the "reserved" variables below, which are just present as
placeholders. See the email abstraction under "Password reset (Phase 02C)"
for how a real provider value gets added to that enum later.

Variables for TikTok, Meta/Instagram, Cloudflare R2, Sentry, and the AI
provider are present in `.env.example` with their final names (so later
phases don't need to rename anything) but are **not** read or validated by
`@socialith/config` yet — an empty value for any of them does not block
Phase 01 from booting. Each is validated starting in the phase that
actually uses it (see inline comments in `.env.example`).

## What Phase 01 deliberately does not include

Per the phased build plan, the following are **not** in this delivery and
should not be added until their phase: authentication/session handling,
OAuth for TikTok/Instagram, campaign/content/publishing domain tables and
routes, video rendering, analytics, and the admin panel. Adding them early
would violate the "smallest complete slice per phase" process in spec §82.
The one deliberate exception, tracked above under "Phase 02 status", is
the database schema and `@socialith/auth` utility package prepared ahead
of the full Phase 02 API/frontend implementation.
