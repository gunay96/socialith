import { prisma } from "@socialith/database";
import {
  findRepetitions,
  validatePublication,
  zonedDayKey,
  zonedDayRange,
  type AssetFacts,
  type MediaVerification,
  type MusicFacts,
  type PlatformKey,
  type ValidationIssue,
} from "@socialith/publishing";
import { effectiveTextOf, type EffectiveSettings, type Publication, PUBLICATION_INCLUDE } from "./publishing-common.js";

/** A music verification older than this is not trusted — the same limit the worker applies (apps/worker/src/upload-post/publish.ts). */
export const MUSIC_VERIFICATION_MAX_AGE_DAYS = 30;
/** Upload-Post accepts schedules at most this far ahead (docs/UPLOAD_POST_API_MAPPING.md). */
export const MAX_SCHEDULE_DAYS_AHEAD = 365;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The media facts recorded on each asset (null = unknown). Exported so the detail page can show what is NOT known. */
export function assetFacts(t: Publication): AssetFacts[] {
  return t.content.assets.map((a) => {
    const meta = a.metadata && typeof a.metadata === "object" && !Array.isArray(a.metadata) ? (a.metadata as Record<string, unknown>) : {};
    return {
      id: a.id,
      type: a.type,
      platform: a.platform as PlatformKey | null,
      width: num(meta.width),
      height: num(meta.height),
      durationSec: num(meta.durationSec) ?? num(meta.duration),
      sizeBytes: num(meta.sizeBytes) ?? num(meta.size),
    };
  });
}

async function musicFacts(t: Publication): Promise<MusicFacts> {
  const soundId = t.content.soundId;
  const base = { soundSelected: soundId !== null, required: t.requireMusic, mapping: null as MusicFacts["mapping"], maxVerificationAgeDays: MUSIC_VERIFICATION_MAX_AGE_DAYS };
  if (!soundId || t.socialAccount.platform !== "TIKTOK") return base;
  const mappings = await prisma.soundMusicMapping.findMany({
    where: { soundId, provider: "UPLOAD_POST_TIKTOK", organizationId: t.content.organizationId },
    orderBy: { updatedAt: "desc" },
  });
  // the worker picks the first usable one; show the same one (else the most recent, to explain what is missing)
  const now = Date.now();
  const best =
    mappings.find((m) => m.availability === "VERIFIED_AVAILABLE" && m.rightsConfirmed && m.verifiedAt !== null && now - m.verifiedAt.getTime() <= MUSIC_VERIFICATION_MAX_AGE_DAYS * 86_400_000) ?? mappings[0] ?? null;
  return { ...base, mapping: best ? { availability: best.availability, rightsConfirmed: best.rightsConfirmed, verifiedAt: best.verifiedAt } : null };
}

/** Other publications of the same destination near `scheduledAt`: how many that day, and how close the nearest one is. */
async function capFacts(t: Publication, scheduledAt: Date | null, settings: EffectiveSettings) {
  const base = { maxPerDay: settings.maxPostsPerDestinationPerDay, minSpacingMinutes: settings.minMinutesBetweenPosts, sameDayCount: 0, nearestNeighbourMinutes: null as number | null, dayLabel: "" };
  if (!scheduledAt) return base;
  const tz = settings.timezone;
  const key = zonedDayKey(scheduledAt, tz);
  const range = zonedDayRange(key, tz);
  const margin = settings.minMinutesBetweenPosts * 60_000;
  const others = await prisma.contentTarget.findMany({
    where: {
      socialAccountId: t.socialAccountId,
      id: { not: t.id },
      status: { in: ["SCHEDULED", "PUBLISHING", "PUBLISHED"] },
      scheduledAt: { gte: new Date(range.start.getTime() - margin), lt: new Date(range.end.getTime() + margin) },
    },
    select: { scheduledAt: true },
  });
  const times = others.map((o) => o.scheduledAt!).filter(Boolean);
  const sameDay = times.filter((d) => d.getTime() >= range.start.getTime() && d.getTime() < range.end.getTime());
  const nearest = times.length ? Math.min(...times.map((d) => Math.abs(d.getTime() - scheduledAt.getTime()))) / 60_000 : null;
  return { ...base, sameDayCount: sameDay.length, nearestNeighbourMinutes: nearest, dayLabel: key };
}

export interface ValidateOptions {
  settings: EffectiveSettings;
  now: Date;
  /** The time being validated (a proposed or planned schedule). */
  scheduledAt: Date | null;
  /** True when this validation gates a scheduling request (a missing time is then an error). */
  scheduleRequired: boolean;
  /** Retry of a failed publication: the daily cap and spacing do not apply to something that already counted. */
  skipCaps?: boolean;
}

/** Platform validation for ONE publication, plus the repetitive-distribution guard against its siblings. */
export async function validatePublicationTarget(t: Publication, opts: ValidateOptions): Promise<{ ok: boolean; issues: ValidationIssue[]; media: MediaVerification; fullyValidated: boolean }> {
  const platform = t.socialAccount.platform as PlatformKey;
  const up = t.socialAccount.uploadPostAccount;
  const text = effectiveTextOf(t);
  const meta = t.socialAccount.providerMetadata;
  const caps = opts.skipCaps ? { maxPerDay: Number.MAX_SAFE_INTEGER, minSpacingMinutes: 0, sameDayCount: 0, nearestNeighbourMinutes: null, dayLabel: "" } : await capFacts(t, opts.scheduledAt, opts.settings);

  const result = validatePublication({
    platform,
    destination: {
      platform,
      handle: t.socialAccount.handle,
      accountStatus: t.socialAccount.status,
      isDemo: typeof meta === "object" && meta !== null && !Array.isArray(meta) && (meta as Record<string, unknown>).seed === true,
      provider: t.socialAccount.publishingProvider,
      uploadPost: up
        ? {
            accountStatus: up.status,
            accountPlatform: up.platform,
            capabilities: Array.isArray(up.capabilities) ? up.capabilities.filter((c): c is string => typeof c === "string") : [],
            profileStatus: up.profile.status,
            profileBlocked: up.profile.blocked,
            identityUnchanged: up.providerAccountId === t.socialAccount.externalAccountId,
          }
        : null,
    },
    assets: assetFacts(t),
    caption: text.caption,
    title: text.title,
    music: await musicFacts(t),
    schedule: { scheduledAt: opts.scheduledAt, required: opts.scheduleRequired, now: opts.now, minLeadMinutes: opts.settings.minLeadMinutes, maxDaysAhead: MAX_SCHEDULE_DAYS_AHEAD, timeZone: opts.settings.timezone },
    caps,
  });

  const issues = [...result.issues, ...(await repetitionIssues(t, opts.settings))];
  const ok = !issues.some((i) => i.severity === "ERROR");
  // `ok` means "nothing is known to be wrong"; only known media facts make it "fully validated" (never assumed).
  return { ok, issues, media: result.media, fullyValidated: ok && result.media.status === "VERIFIED" };
}

/**
 * The same asset with (nearly) the same text on several destinations of one platform is not allowed. The destination
 * that was created FIRST keeps its text; each later one must be written for its own page.
 */
async function repetitionIssues(t: Publication, settings: EffectiveSettings): Promise<ValidationIssue[]> {
  if (settings.duplicateGuard === "OFF") return [];
  const siblings = await prisma.contentTarget.findMany({
    where: {
      contentId: t.contentId,
      socialAccount: { platform: t.socialAccount.platform },
      // a cancelled or rejected sibling is not going out, so it does not make this one a repeat
      // (explicit null handling: `NOT (exception = 'CANCELLED')` is NULL — the row would vanish — when exception IS NULL)
      AND: [{ OR: [{ exception: null }, { exception: { not: "CANCELLED" } }] }, { approvalStatus: { not: "REJECTED" } }],
    },
    include: PUBLICATION_INCLUDE,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const items = siblings.map((s) => ({ id: s.id, platform: s.socialAccount.platform, contentId: s.contentId, text: effectiveTextOf(s).caption }));
  if (!items.some((i) => i.id === t.id)) items.push({ id: t.id, platform: t.socialAccount.platform, contentId: t.contentId, text: effectiveTextOf(t).caption });
  const repeat = findRepetitions(items, settings.similarityThresholdPct, settings.maxSimilarPerPlatform).find((r) => r.id === t.id);
  if (!repeat) return [];
  const other = siblings.find((s) => s.id === repeat.repeats);
  return [
    {
      code: "DUPLICATE_CONTENT",
      severity: settings.duplicateGuard === "BLOCK" ? "ERROR" : "WARNING",
      field: "content",
      message: `This ${t.socialAccount.platform.toLowerCase()} post is ${repeat.similarityPct}% the same as the one for @${other?.socialAccount.handle ?? "another destination"} (same media). Write a caption for this page, or remove this destination — the same post is not sent to several pages unchanged.`,
    },
  ];
}
