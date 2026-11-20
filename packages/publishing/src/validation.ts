/**
 * Pre-schedule platform validation — pure, no I/O. Instagram, TikTok and YouTube do NOT share capabilities, so every
 * rule is keyed by platform. Each issue is actionable (what is wrong, what to do) and has a stable `code`.
 *
 *   ERROR    blocks submitting/scheduling
 *   WARNING  allowed, but the publication will behave differently than the operator may expect (or could not be verified)
 *   INFO     informational
 *
 * Limits live in PLATFORM_RULES (data, easy to correct). Only limits that are documented by the platform or by
 * Upload-Post are ERRORs; everything about video duration, size and aspect that could not be verified against a
 * live account is a WARNING or a generous hard cap — see docs/PUBLISHING_WORKFLOW.md for the list and its status.
 */

export type PlatformKey = "TIKTOK" | "INSTAGRAM" | "YOUTUBE";
export type Severity = "ERROR" | "WARNING" | "INFO";
export type IssueField = "account" | "media" | "caption" | "title" | "music" | "schedule" | "limits" | "content";

export interface ValidationIssue {
  code: string;
  severity: Severity;
  field: IssueField;
  message: string;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export interface PlatformRule {
  label: string;
  /** May a post consist of images only? Of a video? */
  images: boolean;
  video: boolean;
  /** ERROR above this many characters of the caption (TikTok/Instagram) or description (YouTube). */
  captionMax: number;
  /** ERROR above this many hashtags in the caption. */
  hashtagMax: number | null;
  /** YouTube: title length. */
  titleMax: number | null;
  /** [min, max] width/height for single images: ERROR outside. */
  imageAspect: [number, number] | null;
  /** [min, max] width/height recommended for video: WARNING outside. */
  videoAspectRecommended: [number, number] | null;
  videoDurationMinSec: number | null;
  /** ERROR above. */
  videoDurationMaxSec: number | null;
  /** WARNING above (eligibility, not rejection). */
  videoDurationRecommendedMaxSec: number | null;
  /** ERROR above. */
  fileMaxBytes: number | null;
  /** WARNING above. */
  fileWarnBytes: number | null;
}

export const PLATFORM_RULES: Record<PlatformKey, PlatformRule> = {
  TIKTOK: {
    label: "TikTok",
    images: true,
    video: true,
    captionMax: 2200,
    hashtagMax: null,
    titleMax: null,
    imageAspect: null,
    videoAspectRecommended: [0.5, 0.75],
    videoDurationMinSec: null,
    videoDurationMaxSec: 3600,
    videoDurationRecommendedMaxSec: null,
    fileMaxBytes: 4 * GB,
    fileWarnBytes: null,
  },
  INSTAGRAM: {
    label: "Instagram",
    images: true,
    video: true,
    captionMax: 2200,
    hashtagMax: 30,
    titleMax: null,
    imageAspect: [0.8, 1.91],
    videoAspectRecommended: [0.5, 0.75],
    videoDurationMinSec: 3,
    videoDurationMaxSec: 900,
    videoDurationRecommendedMaxSec: 90,
    fileMaxBytes: null,
    fileWarnBytes: 300 * MB,
  },
  YOUTUBE: {
    label: "YouTube",
    images: false,
    video: true,
    captionMax: 5000,
    hashtagMax: null,
    titleMax: 100,
    imageAspect: null,
    videoAspectRecommended: null,
    videoDurationMinSec: null,
    videoDurationMaxSec: null,
    videoDurationRecommendedMaxSec: null,
    fileMaxBytes: null,
    fileWarnBytes: null,
  },
};

export interface AssetFacts {
  id: string;
  type: "IMAGE" | "VIDEO" | "AUDIO" | "THUMBNAIL";
  /** null = shared across platforms */
  platform: PlatformKey | null;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
  sizeBytes?: number | null;
}

export interface DestinationFacts {
  platform: PlatformKey;
  handle: string;
  /** SocialAccount.status */
  accountStatus: string;
  isDemo: boolean;
  provider: "NATIVE" | "UPLOAD_POST";
  uploadPost: null | {
    accountStatus: "CONNECTED" | "REAUTH_REQUIRED" | "DISCONNECTED";
    accountPlatform: string;
    capabilities: string[];
    profileStatus: "ACTIVE" | "REMOVED";
    profileBlocked: boolean;
    /** providerAccountId still equals SocialAccount.externalAccountId */
    identityUnchanged: boolean;
  };
}

export interface MusicFacts {
  soundSelected: boolean;
  /** Make the music conditions errors instead of warnings. */
  required: boolean;
  mapping: null | { availability: "UNVERIFIED" | "VERIFIED_AVAILABLE" | "UNAVAILABLE"; rightsConfirmed: boolean; verifiedAt: Date | null };
  maxVerificationAgeDays: number;
}

export interface ScheduleFacts {
  scheduledAt: Date | null;
  /** True when this validation gates a scheduling request. */
  required: boolean;
  now: Date;
  minLeadMinutes: number;
  maxDaysAhead: number;
  timeZone: string;
}

export interface CapFacts {
  maxPerDay: number;
  /** Other publications of this destination on the same local day that are scheduled, in flight or published. */
  sameDayCount: number;
  minSpacingMinutes: number;
  /** Minutes to the closest other publication of this destination, if any. */
  nearestNeighbourMinutes: number | null;
  dayLabel: string;
}

export interface ValidationInput {
  platform: PlatformKey;
  destination: DestinationFacts;
  assets: AssetFacts[];
  caption: string | null;
  title: string | null;
  music: MusicFacts;
  schedule: ScheduleFacts;
  caps: CapFacts;
}

const HASHTAG = /#[\p{L}\p{N}_]+/gu;
const chars = (s: string) => [...s].length;
const issue = (severity: Severity, field: IssueField, code: string, message: string): ValidationIssue => ({ code, severity, field, message });

export function validatePublication(input: ValidationInput): { ok: boolean; issues: ValidationIssue[] } {
  const rule = PLATFORM_RULES[input.platform];
  const issues: ValidationIssue[] = [];
  const add = (...i: ValidationIssue[]) => issues.push(...i);

  add(...accountIssues(input, rule));
  add(...mediaIssues(input, rule));
  add(...textIssues(input, rule));
  add(...musicIssues(input, rule));
  add(...scheduleIssues(input));
  add(...capIssues(input));

  return { ok: !issues.some((i) => i.severity === "ERROR"), issues };
}

/** Account / provider readiness of one destination for one platform (what the destination picker shows). */
export function validateDestination(destination: DestinationFacts, platform: PlatformKey): ValidationIssue[] {
  return accountIssues({ platform, destination } as ValidationInput, PLATFORM_RULES[platform]);
}

function accountIssues(input: ValidationInput, rule: PlatformRule): ValidationIssue[] {
  const d = input.destination;
  const out: ValidationIssue[] = [];
  if (d.isDemo) out.push(issue("ERROR", "account", "ACCOUNT_DEMO", `@${d.handle} is a demo/seed account and can never publish. Choose a real destination.`));
  if (d.platform !== input.platform) out.push(issue("ERROR", "account", "ACCOUNT_PLATFORM_MISMATCH", `This destination is a ${PLATFORM_RULES[d.platform].label} account, not ${rule.label}.`));
  if (d.accountStatus !== "CONNECTED") out.push(issue("ERROR", "account", "ACCOUNT_NOT_CONNECTED", `@${d.handle} is ${d.accountStatus.toLowerCase()}. Reconnect the account, then try again.`));
  if (d.provider === "UPLOAD_POST") {
    const u = d.uploadPost;
    if (!u) {
      out.push(issue("ERROR", "account", "DESTINATION_NOT_LINKED", `@${d.handle} is not linked to an Upload-Post account. Enable it as a publishing destination first.`));
    } else {
      if (!u.identityUnchanged) out.push(issue("ERROR", "account", "PROVIDER_IDENTITY_CHANGED", `A different account is now connected behind @${d.handle} at Upload-Post. Review it and re-enable the destination.`));
      if (u.accountPlatform.toLowerCase() !== input.platform.toLowerCase()) out.push(issue("ERROR", "account", "PROVIDER_PLATFORM_MISMATCH", `The Upload-Post account behind @${d.handle} is ${u.accountPlatform}, not ${rule.label}.`));
      if (u.accountStatus === "REAUTH_REQUIRED") out.push(issue("ERROR", "account", "PROVIDER_REAUTH_REQUIRED", `Upload-Post reports that @${d.handle} must be reconnected (authorization expired). Reconnect it in Upload-Post, run Sync now, then try again.`));
      if (u.accountStatus === "DISCONNECTED") out.push(issue("ERROR", "account", "PROVIDER_DISCONNECTED", `@${d.handle} is no longer connected in its Upload-Post profile. Reconnect it there, then run Sync now.`));
      if (u.profileStatus === "REMOVED") out.push(issue("ERROR", "account", "PROVIDER_PROFILE_REMOVED", `The Upload-Post profile of @${d.handle} no longer exists at the provider.`));
      if (u.profileBlocked) out.push(issue("ERROR", "account", "PROVIDER_PROFILE_BLOCKED", `Upload-Post reports the profile of @${d.handle} as blocked. Resolve it with Upload-Post support.`));
    }
  }
  return out;
}

function mediaIssues(input: ValidationInput, rule: PlatformRule): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const relevant = input.assets.filter((a) => a.platform === null || a.platform === input.platform);
  const videos = relevant.filter((a) => a.type === "VIDEO");
  const images = relevant.filter((a) => a.type === "IMAGE");

  if (videos.length === 0 && images.length === 0) {
    out.push(issue("ERROR", "media", "MEDIA_MISSING", `There is no ${rule.images ? "video or image" : "video"} to publish to ${rule.label}. Add media to the content first (audio files and thumbnails cannot be published on their own).`));
    return out;
  }
  if (videos.length === 0 && !rule.images) {
    out.push(issue("ERROR", "media", "MEDIA_UNSUPPORTED", `${rule.label} publishing needs a video; this content only has images. Add a video or remove this destination.`));
    return out;
  }
  if (videos.length > 0 && images.length > 0) {
    out.push(issue("WARNING", "media", "MEDIA_MIXED", "The content has both a video and images. The video will be published and the images ignored for this destination."));
  }

  if (videos.length > 0) {
    if (videos.length > 1) out.push(issue("WARNING", "media", "MEDIA_MULTIPLE_VIDEOS", "More than one video is attached; only the first one is published."));
    const v = videos[0]!;
    let unknown = false;
    const w = v.width ?? null;
    const h = v.height ?? null;
    if (w && h) {
      const ratio = w / h;
      const rec = rule.videoAspectRecommended;
      if (rec && (ratio < rec[0] || ratio > rec[1])) {
        out.push(issue("WARNING", "media", "VIDEO_ASPECT", `The video is ${w}×${h} (${ratio.toFixed(2)}:1). ${rule.label} short-form video works best vertical (9:16); a different shape may be cropped or letter-boxed.`));
      }
    } else unknown = true;
    const dur = v.durationSec ?? null;
    if (dur !== null) {
      if (rule.videoDurationMinSec !== null && dur < rule.videoDurationMinSec) out.push(issue("ERROR", "media", "VIDEO_TOO_SHORT", `The video is ${dur.toFixed(1)} s; ${rule.label} needs at least ${rule.videoDurationMinSec} s.`));
      if (rule.videoDurationMaxSec !== null && dur > rule.videoDurationMaxSec) out.push(issue("ERROR", "media", "VIDEO_TOO_LONG", `The video is ${Math.round(dur)} s; ${rule.label} accepts at most ${rule.videoDurationMaxSec} s. Shorten it.`));
      else if (rule.videoDurationRecommendedMaxSec !== null && dur > rule.videoDurationRecommendedMaxSec) out.push(issue("WARNING", "media", "VIDEO_DURATION_ELIGIBILITY", `The video is ${Math.round(dur)} s; ${rule.label} short-form (Reels) is intended for videos up to ${rule.videoDurationRecommendedMaxSec} s, so it may not be eligible for that format.`));
      if (input.platform === "YOUTUBE" && dur > 180 && w && h && w / h < 1) out.push(issue("INFO", "media", "YOUTUBE_NOT_A_SHORT", "This vertical video is longer than 3 minutes, so YouTube will treat it as a regular video, not a Short."));
    } else unknown = true;
    const size = v.sizeBytes ?? null;
    if (size !== null) {
      if (rule.fileMaxBytes !== null && size > rule.fileMaxBytes) out.push(issue("ERROR", "media", "FILE_TOO_LARGE", `The video is ${(size / MB).toFixed(0)} MB; ${rule.label} accepts at most ${(rule.fileMaxBytes / MB).toFixed(0)} MB.`));
      else if (rule.fileWarnBytes !== null && size > rule.fileWarnBytes) out.push(issue("WARNING", "media", "FILE_LARGE", `The video is ${(size / MB).toFixed(0)} MB; ${rule.label} may reject or slow down uploads above about ${(rule.fileWarnBytes / MB).toFixed(0)} MB.`));
    } else unknown = true;
    if (unknown) out.push(issue("WARNING", "media", "MEDIA_FACTS_UNKNOWN", "Dimensions, duration or file size of the video are not recorded, so the aspect ratio, duration and file-size limits could not be checked."));
  } else if (rule.imageAspect) {
    const [lo, hi] = rule.imageAspect;
    for (const img of images) {
      if (img.width && img.height) {
        const ratio = img.width / img.height;
        if (ratio < lo || ratio > hi) out.push(issue("ERROR", "media", "IMAGE_ASPECT", `An image is ${img.width}×${img.height} (${ratio.toFixed(2)}:1); ${rule.label} feed images must be between ${lo}:1 and ${hi}:1 (4:5 to 1.91:1). Crop it.`));
      } else {
        out.push(issue("WARNING", "media", "MEDIA_FACTS_UNKNOWN", "Image dimensions are not recorded, so the aspect-ratio limit could not be checked."));
        break;
      }
    }
  }
  return out;
}

function textIssues(input: ValidationInput, rule: PlatformRule): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const caption = input.caption ?? "";
  const len = chars(caption);
  const what = input.platform === "YOUTUBE" ? "description" : "caption";
  if (len > rule.captionMax) out.push(issue("ERROR", "caption", "CAPTION_TOO_LONG", `The ${what} is ${len} characters; ${rule.label} allows at most ${rule.captionMax}. Shorten it by ${len - rule.captionMax}.`));
  if (rule.hashtagMax !== null) {
    const tags = caption.match(HASHTAG)?.length ?? 0;
    if (tags > rule.hashtagMax) out.push(issue("ERROR", "caption", "TOO_MANY_HASHTAGS", `The caption has ${tags} hashtags; ${rule.label} allows at most ${rule.hashtagMax}. Remove ${tags - rule.hashtagMax}.`));
  }
  if (rule.titleMax !== null) {
    const title = (input.title ?? "").trim();
    if (title) {
      if (chars(title) > rule.titleMax) out.push(issue("ERROR", "title", "TITLE_TOO_LONG", `The title is ${chars(title)} characters; ${rule.label} allows at most ${rule.titleMax}.`));
    } else {
      const firstLine = caption.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
      if (!firstLine) out.push(issue("WARNING", "title", "TITLE_MISSING", `No ${rule.label} title and no caption: the video would be published as "Untitled". Add a title.`));
      else if (chars(firstLine) > rule.titleMax) out.push(issue("WARNING", "title", "TITLE_FROM_CAPTION_TRUNCATED", `No title set: the first caption line (${chars(firstLine)} characters) will be cut to ${rule.titleMax} to become the ${rule.label} title. Set a title.`));
      else out.push(issue("INFO", "title", "TITLE_FROM_CAPTION", `No title set: the first caption line will be used as the ${rule.label} title.`));
    }
  }
  if (!caption.trim() && input.platform !== "YOUTUBE") out.push(issue("INFO", "caption", "CAPTION_EMPTY", `The ${what} is empty; the post will have no text.`));
  return out;
}

function musicIssues(input: ValidationInput, rule: PlatformRule): ValidationIssue[] {
  const m = input.music;
  if (!m.soundSelected) return [];
  if (input.platform !== "TIKTOK") {
    return [issue("INFO", "music", "MUSIC_NOT_APPLICABLE", `The selected track is only attached on TikTok; ${rule.label} publishes without it.`)];
  }
  const sev: Severity = m.required ? "ERROR" : "WARNING";
  const tail = m.required ? "Fix this or untick \"require the track\"." : "The post would be published without the track.";
  const d = input.destination;
  if (d.provider !== "UPLOAD_POST") return [issue(sev, "music", "MUSIC_NOT_SUPPORTED", `Native TikTok publishing cannot attach a library track. ${tail}`)];
  const out: ValidationIssue[] = [];
  if (d.uploadPost && !d.uploadPost.capabilities.includes("music")) out.push(issue(sev, "music", "MUSIC_CAPABILITY_MISSING", `The TikTok account does not report the music capability (reconnect it in Upload-Post). ${tail}`));
  if (!m.mapping) {
    out.push(issue(sev, "music", "MUSIC_NO_MAPPING", `The track has no TikTok music mapping yet. Create and verify one on the Sounds page. ${tail}`));
    return out;
  }
  if (m.mapping.availability !== "VERIFIED_AVAILABLE") out.push(issue(sev, "music", "MUSIC_NOT_VERIFIED", `The track's TikTok mapping is ${m.mapping.availability.toLowerCase().replace("_", " ")} — it was not found in the Commercial Music Library charts. ${tail}`));
  if (!m.mapping.rightsConfirmed) out.push(issue(sev, "music", "MUSIC_RIGHTS_NOT_CONFIRMED", `Rights for promotional use of this track have not been confirmed by a person. An admin must confirm them on the Sounds page. ${tail}`));
  const verified = m.mapping.verifiedAt;
  if (!verified || input.schedule.now.getTime() - verified.getTime() > m.maxVerificationAgeDays * 86_400_000) {
    out.push(issue(sev, "music", "MUSIC_VERIFICATION_STALE", `The track's availability was not verified in the last ${m.maxVerificationAgeDays} days. Verify it again on the Sounds page. ${tail}`));
  }
  return out;
}

function scheduleIssues(input: ValidationInput): ValidationIssue[] {
  const s = input.schedule;
  if (!s.scheduledAt) {
    return s.required ? [issue("ERROR", "schedule", "SCHEDULE_REQUIRED", "Choose a date and time to schedule this publication.")] : [];
  }
  const diffMs = s.scheduledAt.getTime() - s.now.getTime();
  if (diffMs < 0) return [issue("ERROR", "schedule", "SCHEDULE_IN_PAST", "The scheduled time is in the past. Choose a future time.")];
  if (diffMs < s.minLeadMinutes * 60_000) return [issue("ERROR", "schedule", "SCHEDULE_TOO_SOON", `Schedule at least ${s.minLeadMinutes} minutes ahead so approval, hand-off and media checks have time to complete.`)];
  if (diffMs > s.maxDaysAhead * 86_400_000) return [issue("ERROR", "schedule", "SCHEDULE_TOO_FAR", `The provider accepts schedules at most ${s.maxDaysAhead} days ahead.`)];
  return [];
}

function capIssues(input: ValidationInput): ValidationIssue[] {
  const c = input.caps;
  const out: ValidationIssue[] = [];
  if (c.sameDayCount >= c.maxPerDay) out.push(issue("ERROR", "limits", "LIMIT_DAILY_CAP", `@${input.destination.handle} already has ${c.sameDayCount} publication(s) on ${c.dayLabel}; the daily cap is ${c.maxPerDay}. Pick another day or raise the cap in Publishing Settings.`));
  if (c.nearestNeighbourMinutes !== null && c.nearestNeighbourMinutes < c.minSpacingMinutes) out.push(issue("ERROR", "limits", "LIMIT_SPACING", `Another publication of @${input.destination.handle} is only ${Math.round(c.nearestNeighbourMinutes)} minutes away; keep at least ${c.minSpacingMinutes} minutes between posts.`));
  return out;
}
