import { describe, expect, it } from "vitest";
import { validatePublication, type AssetFacts, type DestinationFacts, type PlatformKey, type ValidationInput } from "./validation.js";

const NOW = new Date("2026-11-20T10:00:00Z");
const IN_2H = new Date(NOW.getTime() + 2 * 3_600_000);

const destination = (platform: PlatformKey, over: Partial<DestinationFacts> = {}): DestinationFacts => ({
  platform,
  handle: "band.official",
  accountStatus: "CONNECTED",
  isDemo: false,
  provider: "UPLOAD_POST",
  uploadPost: { accountStatus: "CONNECTED", accountPlatform: platform.toLowerCase(), capabilities: ["music"], profileStatus: "ACTIVE", profileBlocked: false, identityUnchanged: true },
  ...over,
});
const video = (over: Partial<AssetFacts> = {}): AssetFacts => ({ id: "v1", type: "VIDEO", platform: null, width: 1080, height: 1920, durationSec: 30, sizeBytes: 20 * 1024 * 1024, ...over });
const image = (over: Partial<AssetFacts> = {}): AssetFacts => ({ id: "i1", type: "IMAGE", platform: null, width: 1080, height: 1350, ...over });

function input(platform: PlatformKey, over: Partial<ValidationInput> = {}): ValidationInput {
  return {
    platform,
    destination: destination(platform),
    assets: [video()],
    caption: "New single out now",
    title: null,
    music: { soundSelected: false, required: false, mapping: null, maxVerificationAgeDays: 30 },
    schedule: { scheduledAt: IN_2H, required: true, now: NOW, minLeadMinutes: 10, maxDaysAhead: 365, timeZone: "Europe/Istanbul" },
    caps: { maxPerDay: 3, sameDayCount: 0, minSpacingMinutes: 60, nearestNeighbourMinutes: null, dayLabel: "20 Nov" },
    ...over,
  };
}
const codes = (i: ValidationInput, severity?: string) => validatePublication(i).issues.filter((x) => !severity || x.severity === severity).map((x) => x.code);

describe("a clean publication", () => {
  it.each(["TIKTOK", "INSTAGRAM", "YOUTUBE"] as const)("%s: no errors", (p) => {
    const r = validatePublication(input(p, { title: p === "YOUTUBE" ? "Official video" : null }));
    expect(r.ok).toBe(true);
    expect(r.issues.filter((i) => i.severity === "ERROR")).toEqual([]);
  });
});

describe("account authorization and provider status", () => {
  it("every account problem blocks, with an actionable message naming the account", () => {
    const cases: [string, Partial<DestinationFacts>][] = [
      ["ACCOUNT_DEMO", { isDemo: true }],
      ["ACCOUNT_NOT_CONNECTED", { accountStatus: "EXPIRED" }],
      ["DESTINATION_NOT_LINKED", { uploadPost: null }],
      ["PROVIDER_REAUTH_REQUIRED", { uploadPost: { ...destination("TIKTOK").uploadPost!, accountStatus: "REAUTH_REQUIRED" } }],
      ["PROVIDER_DISCONNECTED", { uploadPost: { ...destination("TIKTOK").uploadPost!, accountStatus: "DISCONNECTED" } }],
      ["PROVIDER_IDENTITY_CHANGED", { uploadPost: { ...destination("TIKTOK").uploadPost!, identityUnchanged: false } }],
      ["PROVIDER_PROFILE_REMOVED", { uploadPost: { ...destination("TIKTOK").uploadPost!, profileStatus: "REMOVED" } }],
      ["PROVIDER_PROFILE_BLOCKED", { uploadPost: { ...destination("TIKTOK").uploadPost!, profileBlocked: true } }],
      ["PROVIDER_PLATFORM_MISMATCH", { uploadPost: { ...destination("TIKTOK").uploadPost!, accountPlatform: "instagram" } }],
    ];
    for (const [code, patch] of cases) {
      const r = validatePublication(input("TIKTOK", { destination: destination("TIKTOK", patch) }));
      expect(r.ok, code).toBe(false);
      const hit = r.issues.find((i) => i.code === code);
      expect(hit?.severity, code).toBe("ERROR");
      expect(hit?.message, code).toContain("band.official");
    }
  });
  it("a native destination needs no Upload-Post link but must still be connected", () => {
    expect(codes(input("YOUTUBE", { destination: destination("YOUTUBE", { provider: "NATIVE", uploadPost: null }), title: "t" }), "ERROR")).toEqual([]);
    expect(codes(input("YOUTUBE", { destination: destination("YOUTUBE", { provider: "NATIVE", uploadPost: null, accountStatus: "ERROR" }), title: "t" }), "ERROR")).toEqual(["ACCOUNT_NOT_CONNECTED"]);
  });
  it("a destination of another platform is refused", () => {
    expect(codes(input("INSTAGRAM", { destination: destination("TIKTOK") }), "ERROR")).toContain("ACCOUNT_PLATFORM_MISMATCH");
  });
});

describe("platforms are NOT interchangeable", () => {
  it("YouTube cannot publish an image-only post; TikTok and Instagram can", () => {
    expect(codes(input("YOUTUBE", { assets: [image()], title: "t" }), "ERROR")).toEqual(["MEDIA_UNSUPPORTED"]);
    expect(codes(input("TIKTOK", { assets: [image()] }), "ERROR")).toEqual([]);
    expect(codes(input("INSTAGRAM", { assets: [image()] }), "ERROR")).toEqual([]);
  });
  it("audio and thumbnails alone are not publishable media", () => {
    const audio: AssetFacts = { id: "a", type: "AUDIO", platform: null };
    const thumb: AssetFacts = { id: "t", type: "THUMBNAIL", platform: null };
    for (const p of ["TIKTOK", "INSTAGRAM", "YOUTUBE"] as const) expect(codes(input(p, { assets: [audio, thumb], title: "t" }), "ERROR")).toEqual(["MEDIA_MISSING"]);
    expect(codes(input("TIKTOK", { assets: [] }), "ERROR")).toEqual(["MEDIA_MISSING"]);
  });
  it("assets restricted to another platform do not count", () => {
    expect(codes(input("TIKTOK", { assets: [video({ platform: "YOUTUBE" })] }), "ERROR")).toEqual(["MEDIA_MISSING"]);
    expect(codes(input("TIKTOK", { assets: [video({ platform: "TIKTOK" })] }), "ERROR")).toEqual([]);
  });
  it("Instagram feed images must be 4:5 … 1.91:1 (error); TikTok has no such rule", () => {
    expect(codes(input("INSTAGRAM", { assets: [image({ width: 1000, height: 2000 })] }), "ERROR")).toEqual(["IMAGE_ASPECT"]);
    expect(codes(input("INSTAGRAM", { assets: [image({ width: 2000, height: 1000 })] }), "ERROR")).toEqual(["IMAGE_ASPECT"]);
    expect(codes(input("INSTAGRAM", { assets: [image({ width: 1080, height: 1080 })] }), "ERROR")).toEqual([]);
    expect(codes(input("TIKTOK", { assets: [image({ width: 1000, height: 2000 })] }), "ERROR")).toEqual([]);
  });
  it("video: wrong aspect is a warning, never a block", () => {
    const r = validatePublication(input("TIKTOK", { assets: [video({ width: 1920, height: 1080 })] }));
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => i.code)).toContain("VIDEO_ASPECT");
  });
  it("duration: Instagram needs ≥ 3 s and ≤ 900 s, warns above 90 s; TikTok/YouTube have different limits", () => {
    expect(codes(input("INSTAGRAM", { assets: [video({ durationSec: 2 })] }), "ERROR")).toEqual(["VIDEO_TOO_SHORT"]);
    expect(codes(input("INSTAGRAM", { assets: [video({ durationSec: 1000 })] }), "ERROR")).toEqual(["VIDEO_TOO_LONG"]);
    expect(codes(input("INSTAGRAM", { assets: [video({ durationSec: 200 })] }), "WARNING")).toContain("VIDEO_DURATION_ELIGIBILITY");
    expect(codes(input("TIKTOK", { assets: [video({ durationSec: 1000 })] }), "ERROR")).toEqual([]);
    expect(codes(input("TIKTOK", { assets: [video({ durationSec: 4000 })] }), "ERROR")).toEqual(["VIDEO_TOO_LONG"]);
    expect(codes(input("YOUTUBE", { assets: [video({ durationSec: 4000 })], title: "t" }), "ERROR")).toEqual([]);
  });
  it("file size: TikTok caps at 4 GB; Instagram only warns above 300 MB", () => {
    expect(codes(input("TIKTOK", { assets: [video({ sizeBytes: 5 * 1024 ** 3 })] }), "ERROR")).toEqual(["FILE_TOO_LARGE"]);
    expect(codes(input("INSTAGRAM", { assets: [video({ sizeBytes: 400 * 1024 ** 2 })] }), "ERROR")).toEqual([]);
    expect(codes(input("INSTAGRAM", { assets: [video({ sizeBytes: 400 * 1024 ** 2 })] }), "WARNING")).toContain("FILE_LARGE");
  });
  it("unknown media facts are surfaced as one warning, not silently skipped and not an error", () => {
    const r = validatePublication(input("TIKTOK", { assets: [video({ width: null, height: null, durationSec: null, sizeBytes: null })] }));
    expect(r.ok).toBe(true);
    expect(r.issues.filter((i) => i.code === "MEDIA_FACTS_UNKNOWN")).toHaveLength(1);
  });
  it("a long vertical video on YouTube is informed to be a regular video, not a Short", () => {
    expect(codes(input("YOUTUBE", { assets: [video({ durationSec: 300 })], title: "t" }))).toContain("YOUTUBE_NOT_A_SHORT");
  });
});

describe("captions and titles", () => {
  const long = (n: number) => "x".repeat(n);
  it("caption limits per platform", () => {
    expect(codes(input("TIKTOK", { caption: long(2201) }), "ERROR")).toEqual(["CAPTION_TOO_LONG"]);
    expect(codes(input("TIKTOK", { caption: long(2200) }), "ERROR")).toEqual([]);
    expect(codes(input("INSTAGRAM", { caption: long(2201) }), "ERROR")).toEqual(["CAPTION_TOO_LONG"]);
    expect(codes(input("YOUTUBE", { caption: long(5001), title: "t" }), "ERROR")).toEqual(["CAPTION_TOO_LONG"]);
    expect(codes(input("YOUTUBE", { caption: long(2201), title: "t" }), "ERROR")).toEqual([]); // 2201 is fine for YouTube
  });
  it("counts characters, not UTF-16 units (emoji)", () => {
    expect(codes(input("TIKTOK", { caption: "🎵".repeat(2200) }), "ERROR")).toEqual([]);
    expect(codes(input("TIKTOK", { caption: "🎵".repeat(2201) }), "ERROR")).toEqual(["CAPTION_TOO_LONG"]);
  });
  it("Instagram allows at most 30 hashtags; TikTok has no hashtag limit", () => {
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `#tag${i}`).join(" ");
    expect(codes(input("INSTAGRAM", { caption: tags(31) }), "ERROR")).toEqual(["TOO_MANY_HASHTAGS"]);
    expect(codes(input("INSTAGRAM", { caption: tags(30) }), "ERROR")).toEqual([]);
    expect(codes(input("TIKTOK", { caption: tags(31) }), "ERROR")).toEqual([]);
  });
  it("YouTube title: ≤ 100 characters; falls back to the first caption line with a warning when that is too long", () => {
    expect(codes(input("YOUTUBE", { title: long(101) }), "ERROR")).toEqual(["TITLE_TOO_LONG"]);
    expect(codes(input("YOUTUBE", { title: null, caption: long(150) }), "WARNING")).toContain("TITLE_FROM_CAPTION_TRUNCATED");
    expect(codes(input("YOUTUBE", { title: null, caption: "Short first line\nmore" }))).toContain("TITLE_FROM_CAPTION");
    expect(codes(input("YOUTUBE", { title: null, caption: null }), "WARNING")).toContain("TITLE_MISSING");
  });
});

describe("music (TikTok only, never assumed)", () => {
  const sound = (mapping: ValidationInput["music"]["mapping"], required = false): ValidationInput["music"] => ({ soundSelected: true, required, mapping, maxVerificationAgeDays: 30 });
  const verified = { availability: "VERIFIED_AVAILABLE" as const, rightsConfirmed: true, verifiedAt: new Date(NOW.getTime() - 86_400_000) };

  it("a verified, rights-confirmed, fresh mapping on a music-capable account raises nothing", () => {
    expect(codes(input("TIKTOK", { music: sound(verified) }))).toEqual([]);
  });
  it("each missing condition is its own issue; a warning by default (the post goes out without music)", () => {
    expect(codes(input("TIKTOK", { music: sound(null) }), "WARNING")).toEqual(["MUSIC_NO_MAPPING"]);
    expect(codes(input("TIKTOK", { music: sound({ ...verified, availability: "UNVERIFIED" }) }), "WARNING")).toEqual(["MUSIC_NOT_VERIFIED"]);
    expect(codes(input("TIKTOK", { music: sound({ ...verified, availability: "UNAVAILABLE" }) }), "WARNING")).toEqual(["MUSIC_NOT_VERIFIED"]);
    expect(codes(input("TIKTOK", { music: sound({ ...verified, rightsConfirmed: false }) }), "WARNING")).toEqual(["MUSIC_RIGHTS_NOT_CONFIRMED"]);
    expect(codes(input("TIKTOK", { music: sound({ ...verified, verifiedAt: new Date(NOW.getTime() - 40 * 86_400_000) }) }), "WARNING")).toEqual(["MUSIC_VERIFICATION_STALE"]);
    expect(codes(input("TIKTOK", { music: sound({ ...verified, verifiedAt: null }) }), "WARNING")).toEqual(["MUSIC_VERIFICATION_STALE"]);
    const noCap = destination("TIKTOK", { uploadPost: { ...destination("TIKTOK").uploadPost!, capabilities: [] } });
    expect(codes(input("TIKTOK", { destination: noCap, music: sound(verified) }), "WARNING")).toEqual(["MUSIC_CAPABILITY_MISSING"]);
  });
  it("'require the track' turns each of them into a blocking error", () => {
    const r = validatePublication(input("TIKTOK", { music: sound({ ...verified, rightsConfirmed: false }, true) }));
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.code === "MUSIC_RIGHTS_NOT_CONFIRMED")?.severity).toBe("ERROR");
  });
  it("native TikTok cannot attach a library track; other platforms just ignore the track", () => {
    expect(codes(input("TIKTOK", { destination: destination("TIKTOK", { provider: "NATIVE", uploadPost: null }), music: sound(verified) }), "WARNING")).toEqual(["MUSIC_NOT_SUPPORTED"]);
    expect(codes(input("INSTAGRAM", { music: sound(verified) }))).toEqual(["MUSIC_NOT_APPLICABLE"]);
    expect(codes(input("INSTAGRAM", { music: sound(null, true) }), "ERROR")).toEqual([]); // "required" does not make an inapplicable track block
  });
});

describe("scheduled time validity", () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms);
  const withTime = (scheduledAt: Date | null, required = true) => input("TIKTOK", { schedule: { scheduledAt, required, now: NOW, minLeadMinutes: 10, maxDaysAhead: 365, timeZone: "Europe/Istanbul" } });
  it("missing (when required), past, too soon, too far", () => {
    expect(codes(withTime(null), "ERROR")).toEqual(["SCHEDULE_REQUIRED"]);
    expect(codes(withTime(null, false), "ERROR")).toEqual([]);
    expect(codes(withTime(at(-60_000)), "ERROR")).toEqual(["SCHEDULE_IN_PAST"]);
    expect(codes(withTime(at(5 * 60_000)), "ERROR")).toEqual(["SCHEDULE_TOO_SOON"]);
    expect(codes(withTime(at(10 * 60_000)), "ERROR")).toEqual([]); // exactly the lead is fine
    expect(codes(withTime(at(366 * 86_400_000)), "ERROR")).toEqual(["SCHEDULE_TOO_FAR"]);
    expect(codes(withTime(at(365 * 86_400_000)), "ERROR")).toEqual([]);
  });
});

describe("publishing limits", () => {
  it("daily cap and minimum spacing per destination", () => {
    expect(codes(input("TIKTOK", { caps: { maxPerDay: 3, sameDayCount: 3, minSpacingMinutes: 60, nearestNeighbourMinutes: null, dayLabel: "20 Nov" } }), "ERROR")).toEqual(["LIMIT_DAILY_CAP"]);
    expect(codes(input("TIKTOK", { caps: { maxPerDay: 3, sameDayCount: 2, minSpacingMinutes: 60, nearestNeighbourMinutes: null, dayLabel: "20 Nov" } }), "ERROR")).toEqual([]);
    expect(codes(input("TIKTOK", { caps: { maxPerDay: 3, sameDayCount: 1, minSpacingMinutes: 60, nearestNeighbourMinutes: 20, dayLabel: "20 Nov" } }), "ERROR")).toEqual(["LIMIT_SPACING"]);
    expect(codes(input("TIKTOK", { caps: { maxPerDay: 3, sameDayCount: 1, minSpacingMinutes: 60, nearestNeighbourMinutes: 60, dayLabel: "20 Nov" } }), "ERROR")).toEqual([]);
  });
});

describe("multiple problems are all reported at once", () => {
  it("returns every error, not just the first", () => {
    const r = validatePublication(input("INSTAGRAM", { caption: "x".repeat(3000), assets: [], schedule: { scheduledAt: new Date(NOW.getTime() - 1), required: true, now: NOW, minLeadMinutes: 10, maxDaysAhead: 365, timeZone: "Europe/Istanbul" }, destination: destination("INSTAGRAM", { accountStatus: "DISCONNECTED" }) }));
    expect(r.ok).toBe(false);
    expect(r.issues.filter((i) => i.severity === "ERROR").map((i) => i.code).sort()).toEqual(["ACCOUNT_NOT_CONNECTED", "CAPTION_TOO_LONG", "MEDIA_MISSING", "SCHEDULE_IN_PAST"]);
    for (const i of r.issues) expect(i.message.length).toBeGreaterThan(15);
  });
});
