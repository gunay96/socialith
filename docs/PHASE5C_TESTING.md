# Phase 5C testing (rendering)

What is tested, where, with which versions, and how to run it. The acceptance report (`PHASE5C_ACCEPTANCE.md`) holds the results of the final run.

## 1. What each layer proves

| Layer | Location | Real parts | Proves |
| --- | --- | --- | --- |
| Pure planning | `packages/studio/src/render-plan.test.ts`, `plan-fixtures.test.ts` | none needed | wrapping with real font advance widths, safe-area shrinking and moving, timeline and `stateAt`, subtitle cues, output decision; **layout fixtures** (`__fixtures__/plans.json`, 96 plans = 6 recipes x 4 texts x 4 aspect ratios) pin line breaks and positions |
| Font table | `packages/video-engine/src/fonts/font-metrics.test.ts` | the installed font files | the committed metrics table equals the real fonts, glyph by glyph (fails in CI if fonts are missing) |
| Renderer | `packages/video-engine/src/render/render.test.ts` | **FFmpeg, ffprobe, font files, files on disk** | every aspect ratio (9:16, 1:1, 16:9, 4:5): decoded frames are measured (ink bounding box, line bands, brightness) and compared with the plan; all five animations against the timeline's numbers; image and video sources of different sizes; audio kept or absent; stills; subtitles; progress; cancel; timeout; output validation catching a wrong size, a missing audio track and a damaged file; readability warning; font fallback |
| Worker processing | `apps/worker/src/integration/render-processing.integration.test.ts` | MySQL 8.4, FFmpeg, local storage | video with audio, still, image to video, links to campaign and page group, usage history exactly once, re-delivery, crash and re-delivery (one output), adopt a stored output, DB refuses duplicate live jobs and second outputs, refusals, source missing / changed / damaged, FFmpeg missing, invalid output, cancel before start and while running, stale scratch directories |
| API | `apps/api/src/integration/renders.integration.test.ts` | MySQL 8.4, Redis / BullMQ, express | recipe resolution order, refusals before queueing, six simultaneous identical requests produce one job, force, cancel (queued and running), retry with frozen settings, roles, organization isolation, lists and counts |
| Everything earlier | all existing suites | | no regression |

"Visual regression" here is **structural**: frames are read back and measured, not compared with stored screenshots (see TD-75). The layout fixtures catch a moved line break or pixel in the shared plan.

## 2. Environments the suite was run in

| Environment | FFmpeg | `fonts-liberation` | Notes |
| --- | --- | --- | --- |
| Debian 12 (bookworm) chroot | 5.1.9 | 1.07.4 | the worker image's base (`node:20-slim`); the table is generated from these fonts |
| Ubuntu 24.04 (noble) chroot | 6.1.1 | 2.1.5 | the same packages as the GitHub Actions runner |
| Ubuntu 26.04 (WSL) | 8.0.1 | 2.1.5 | the host Linux |
| Windows 11 | 9.0.1 | n/a (Arial / Times / Courier stand-ins, reported) | developer machine |

The Linux environments are real Linux userlands on one WSL2 kernel with throwaway MySQL 8.4 and Redis servers; they are **not** Docker containers. Docker Desktop could not be started on the development machine, so the Docker **image builds were not run locally**; the CI `images` job does that.

## 3. Defects the multi-version runs found (and fixed)

| Found on | Defect | Fix |
| --- | --- | --- |
| Debian 12 / FFmpeg 5.1.9 | `drawbox ... replace=1` crashes FFmpeg with SIGSEGV (box and band backgrounds) | the text layer is created in the background colour and opacity; no `drawbox` |
| Ubuntu 24.04 / FFmpeg 6.1 | FFmpeg's last progress line can be a few ms short (2987 of 3000 ms), so progress did not reach the total | progress is set to the exact total once FFmpeg has exited successfully |
| Linux (Liberation 2.1.5 vs 1.07.4) | the metrics table (generated on Windows) did not match the fonts; U+00B7, U+040D, U+2011 differ between font versions | table regenerated from the Debian 12 files; those three characters are refused (TD-73) |
| Linux | a test assumed missing fonts always fall back (true only with Windows stand-ins) | test split by platform |
| Test setup | a dev worker attached to the same Redis consumed integration-test jobs | do not run a dev worker against the test Redis |

## 4. How to run

Linux or WSL with `ffmpeg fonts-dejavu-core fonts-liberation`, MySQL 8.4 and Redis (the compose file `docker-compose.mysql-test.yml` provides them where Docker works):

```bash
export MYSQL_INTEGRATION_URL="mysql://socialith:it-app-throwaway@127.0.0.1:3384/socialith_it"
export REDIS_INTEGRATION_URL="redis://127.0.0.1:6390"
export DATABASE_URL="mysql://root:it-root-throwaway@127.0.0.1:3384/socialith_drift"   # a fresh database for migrate deploy
export CI=true                                   # FFmpeg or fonts missing = failure, not a skip
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @socialith/database exec prisma migrate deploy
pnpm --filter @socialith/database exec prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
pnpm --filter @socialith/api test:mysql
pnpm --filter @socialith/worker test:integration
pnpm build
```

Only the renderer: `pnpm --filter @socialith/video-engine test` (needs FFmpeg and the fonts; without `CI=true` it skips what it cannot run).

Regenerate the metrics table (only when the worker image's font packages change), inside the worker's OS:

```bash
cd apps/worker && pnpm exec tsx ../../packages/video-engine/scripts/generate-font-metrics.ts ../../packages/studio/src/font-metrics.data.ts \
  liberation-sans:REGULAR=/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf liberation-sans:BOLD=... (all ten faces)
```

Accept an intended layout change: `pnpm --filter @socialith/studio exec vitest run -u`, then review and commit `plans.json`.

## 5. Browser run

On a throwaway database with the real API, worker and web app (Windows host, FFmpeg 9.0.1): installed the five presets; chose a video, a page and an approved text in **Rendering → New render**; the plan-based preview showed the recipe candidates, checks and a scrubbable preview over the real video; started the render; the job page showed the real output (`<video>` from storage, 1080 x 1920, h264 + AAC, 5 s) with its check table, provenance and frozen settings; a 90 s clip showed real progress ("0:09 of 1:30 rendered, 10.1 %"); **Cancel** stopped it and listed it under cancelled; starting the same render again showed "This exact render was already made" with the open / render-again-on-purpose choices. Not verified in a browser: a failed render's presentation (covered by the API and worker tests), phone-width layout beyond the known shell limitation (TD-65).
