# Publishing operations — runbook for the agency team

How to run the Publishing Center day to day, what the statuses mean, and what to do when something goes wrong. Rules and definitions: `PUBLISHING_WORKFLOW.md`. Setup of the provider: `UPLOAD_POST_SETUP.md`.

## 1. Before anything is published for real

1. **Approval is already on** (product default, nothing to save): every destination must be approved before it can be scheduled. Switching it off is an explicit choice in *Publishing Settings* (admin) and is audited. Check *Publishing Settings* to confirm who may approve their own work (owner: yes; admin: no, by default).
2. **Check the destinations.** *Account Selection* shows every destination with READY / NOT READY and the reason (disconnected, needs reconnecting in Upload-Post, profile blocked, …). Fix those in Upload-Post, then *Upload-Post → Sync now*.
3. **Real publishing needs a separate, explicit go-ahead naming a designated test account.** Nothing in Phase 3 publishes to a real account; the tests use a contract double. Follow the checklist in `PUBLISHING_TESTING.md` §6 for the first real post.
4. Leave **hand-off to the Upload-Post scheduler off**. It needs a separate live verification and the owner's explicit approval, and two environment switches (`UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED` **and** `UPLOAD_POST_HANDOFF_OWNER_APPROVED`) — one alone refuses to boot (`UPLOAD_POST_SETUP.md` §8).

## 2. The daily flow

| Step | Where | Who |
|---|---|---|
| Create the content, attach media, pick the track | Content, Music / Sounds | editor |
| Choose destinations; write a caption **for each page**; plan a time (optionally staggered) | *New publication* | editor |
| Fix what the platform checks report; submit each destination for review | publication / result list | editor |
| Review and approve or reject (reason) — one destination at a time | *Approval Center* | admin |
| Schedule (or let a campaign's automatic scheduling do it at the planned time) | publication, calendar | editor |
| Watch | *Overview*, *Publishing Calendar*, *Publishing Queue*, *Scheduled Posts* | everyone |
| Handle exceptions | *Failed Publications* | editor |

Tips: the calendar shows times in the organization timezone (Europe/Istanbul by default); `P` on a calendar item = the Upload-Post scheduler holds that post, no `P` = Socialith's own queue. *Create schedule* and the `+` on a day pre-fill that date.

## 3. Statuses — what to do

| You see | It means | Do |
|---|---|---|
| `Draft` / `Rejected` | not reviewed / refused with a reason | fix the text, **Submit for review** |
| `Ready for review` | waiting for an admin | admin: open it, read the platform checks, **Approve** or **Reject…** |
| `Approved` | reviewed, no time yet (or the planned time is still to be scheduled) | **Schedule…** |
| `Scheduled` | will be published at the time shown | nothing; **Reschedule / Unschedule / Hold / Cancel** if plans change |
| `Held` | parked: by an operator, **or by the approval gate** because it was not approved / its content changed after approval | read the reason on the publication; re-approve, then **Release** or **Reschedule** |
| `Queued` / `Publishing` | in flight | wait; the result arrives by webhook, polling is the fallback |
| `Published` | done | — |
| `Failed` | the platform or provider refused it; permanent errors are not retried by themselves | read the reason and the attempt list; fix the cause (reconnect the account, shorten the caption, …) then **Retry** |
| `Stale` | it missed its slot by more than the stale window (default 30 min) — a worker outage, a restored Redis, an old plan. **It was not published late.** | decide: **Publish now** (retry) or **Reschedule** |
| `Cancelled` | cancelled; history kept | **Reopen** if it was a mistake |

A `Failed` publication whose last attempt was an **unknown outcome** (timeout, unreadable answer) is not re-sent blindly: the retry first asks Upload-Post (by request id) what happened and adopts the post if it exists.

## 4. Common situations

| Situation | What happens / what to do |
|---|---|
| **A destination's account needs reconnecting** | its publications cannot be submitted/scheduled (validation says so); already scheduled ones fail with "must be reconnected" and are not retried. Reconnect in Upload-Post → *Sync now* → retry. |
| **Cancel or reschedule something already at Upload-Post** | do it in the Publishing Center. The database changes first and an immediate sweep edits/cancels the provider job (within seconds). If the provider is about to run it (< 2 min) the action is refused — wait for the result. |
| **Content edited after approval** | the approval is withdrawn automatically: a scheduled publication returns to *Draft*, the scheduler would hold it anyway. Re-submit and re-approve. |
| **Two pages would get the same text** | the second is blocked ("write a caption for this page"). Write a distinct caption, or remove the destination. The sensitivity is in Publishing Settings (block / warn / off, similarity %, how many may share). |
| **Daily cap / spacing reached** | scheduling is refused with the date and the cap; pick another day or raise the cap in settings. |
| **TikTok track is not attached** | a *warning* by default (the post goes out without it, and the reason is stored); tick **Require the track** on that destination to make it blocking. Verify the track's mapping and confirm its rights (admin) on the Sounds page. |
| **A publication is `Queued` for long** | the publishing worker is not consuming (see §5). Nothing is lost: a job lost with Redis is re-created from the database by the reconciler. |
| **An admin gets "Admins cannot approve what they submitted themselves"** | the default policy: the owner or another admin approves it (or the owner allows admin self-approval in Publishing Settings; every self-approval is audited). |
| **Platform checks say "NOT FULLY VALIDATED - media UNVERIFIED"** | the file's dimensions / duration / size are not recorded, so those limits were **not** checked (there is no media probing yet, TD-49); the account, provider and caption checks passed. Decide with that in mind - the platform may still refuse the file. |
| **Everything shows `Stale` after an outage** | expected and safe: nothing was published late. Review, then publish now or reschedule each (or the ones that still matter). |

## 5. Health and recovery

| Check | How |
|---|---|
| API / workers / Redis / queue backlog | `GET /api/health` (queues: waiting, active, delayed, failed) |
| Upload-Post connection, plan, sync | *Upload-Post → Overview / Provider health / Plan & usage* |
| Scheduling recovered after Redis was wiped or restored | the scheduling reconciler runs on a schedule and on start; it re-creates missing jobs at the earliest remaining target's time, holds stale targets, restores missing publishing/poll jobs. To force it: restart the worker. |
| Webhook reachable | Upload-Post *test notification* answers 200; a wrong signature answers 401; no secret configured answers 503 (polling still works) |
| Stuck in `Publishing` | after the stuck threshold (default 20 min) the reconciler restores the job or the status poll; after 24 h it fails the target with a message (manual retry). |

Never edit the database by hand to "unstick" a publication. Every state is derived from the stored columns; use the dashboard actions, which keep the history and the jobs in step.

## 6. Settings reference (Publishing Settings, admin)

| Setting | Default for a new row | Effect |
|---|---|---|
| Require approval | **on** (also for an organization that never saved settings) | every destination must be approved before it can be scheduled or published, through any path; switching it off is explicit and audited |
| Owner may approve own submissions | on | a self-approval is always audited |
| Admins may approve own submissions | **off** | off = the owner or another admin must approve; a creator can never approve |
| Schedule automatically once approved | off | at the planned time only; campaign can override |
| Timezone | Europe/Istanbul | entry/display and the meaning of "same day" |
| Minimum lead time | 10 min | nothing is scheduled closer to now |
| Posts per destination per day / minimum spacing | 3 / 60 min | enforced when scheduling |
| Repetitive-distribution guard | block, 85 %, 1 | see `PUBLISHING_WORKFLOW.md` §7 |
