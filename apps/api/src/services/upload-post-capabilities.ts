/**
 * Which platforms can Socialith actually use through Upload-Post RIGHT NOW?
 *
 * Upload-Post does not publish a "platforms included in your plan" list through its API, so a platform is only
 * ever reported AVAILABLE when the provider has CONFIRMED access by returning a connected account for it in a
 * synchronized, active, non-blocked profile. Everything else is UNAVAILABLE (or REAUTH_REQUIRED / PENDING) with a
 * human reason. Nothing here is assumed, defaulted or simulated; with no data every platform is UNAVAILABLE.
 * Pure function: no database, no provider call.
 */

export type PlatformState = "AVAILABLE" | "REAUTH_REQUIRED" | "PENDING" | "UNAVAILABLE";

export interface CapabilityProfileInput {
  id: string;
  username: string;
  status: "ACTIVE" | "REMOVED";
  blocked: boolean;
  pendingPlatforms: string[];
  accounts: { platform: string; status: "CONNECTED" | "REAUTH_REQUIRED" | "DISCONNECTED"; socialAccountId: string | null; capabilities: string[] }[];
}

export interface PlatformFeature {
  key: "music";
  label: string;
  state: "AVAILABLE" | "UNAVAILABLE";
  reason: string | null;
}

export interface PlatformAvailability {
  platform: string;
  label: string;
  /** Socialith can publish to it (Platform enum). Other platforms are synchronized and shown only. */
  publishable: boolean;
  state: PlatformState;
  reason: string | null;
  accounts: { connected: number; reauthRequired: number; pending: number; disconnected: number };
  destinations: number;
  /** Active, usable profiles that still have a free slot for this platform (one account per platform per profile). */
  connectableProfiles: { id: string; username: string }[];
  features: PlatformFeature[];
}

/** The platforms Socialith can publish to today; always listed, even when nothing is connected. */
export const PUBLISHABLE_PLATFORM_KEYS = ["tiktok", "instagram", "youtube"] as const;

const LABELS: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", facebook: "Facebook", x: "X", linkedin: "LinkedIn", threads: "Threads", pinterest: "Pinterest", bluesky: "Bluesky", reddit: "Reddit" };
const labelOf = (p: string) => LABELS[p] ?? p.charAt(0).toUpperCase() + p.slice(1);

export function derivePlatformAvailability(input: { synced: boolean; profiles: CapabilityProfileInput[] }): PlatformAvailability[] {
  const active = input.profiles.filter((p) => p.status === "ACTIVE");
  const usable = active.filter((p) => !p.blocked);

  const seen = new Set<string>(PUBLISHABLE_PLATFORM_KEYS);
  for (const p of active) for (const a of p.accounts) seen.add(a.platform);

  const publishable = new Set<string>(PUBLISHABLE_PLATFORM_KEYS);
  const ordered = [...PUBLISHABLE_PLATFORM_KEYS, ...[...seen].filter((p) => !publishable.has(p)).sort()];

  return ordered.map((platform) => {
    const label = labelOf(platform);
    const rows = active.flatMap((p) => p.accounts.filter((a) => a.platform === platform).map((a) => ({ ...a, blocked: p.blocked })));
    const live = rows.filter((a) => a.status !== "DISCONNECTED");
    const confirmed = live.filter((a) => a.status === "CONNECTED" && !a.blocked);
    const reauth = live.filter((a) => a.status === "REAUTH_REQUIRED" && !a.blocked);
    const pendingProfiles = usable.filter((p) => p.pendingPlatforms.includes(platform) && !p.accounts.some((a) => a.platform === platform && a.status !== "DISCONNECTED"));

    let state: PlatformState;
    let reason: string | null;
    if (confirmed.length > 0) {
      state = "AVAILABLE";
      reason = null;
    } else if (reauth.length > 0) {
      state = "REAUTH_REQUIRED";
      reason = `The ${label} account must be reconnected in Upload-Post (authorization expired).`;
    } else if (pendingProfiles.length > 0) {
      state = "PENDING";
      reason = `A ${label} connection was started in Upload-Post but not finished.`;
    } else {
      state = "UNAVAILABLE";
      if (!input.synced) reason = `Upload-Post has not been synchronized yet, so access to ${label} is not confirmed.`;
      else if (live.length > 0) reason = `The Upload-Post profile holding the ${label} account is blocked by the provider.`;
      else if (active.length === 0) reason = `No Upload-Post profile exists yet. Create one in Upload-Post, connect ${label} to it, then run Sync now.`;
      else reason = `No ${label} account is connected in any Upload-Post profile, so the provider has not confirmed access. Connect it in Upload-Post, then run Sync now.`;
    }

    const connectableProfiles = usable
      .filter((p) => !p.accounts.some((a) => a.platform === platform && a.status !== "DISCONNECTED"))
      .map((p) => ({ id: p.id, username: p.username }));

    const features: PlatformFeature[] = [];
    if (platform === "tiktok") {
      const withMusic = confirmed.some((a) => a.capabilities.includes("music"));
      features.push({
        key: "music",
        label: "Commercial Music Library",
        state: withMusic ? "AVAILABLE" : "UNAVAILABLE",
        reason: withMusic ? null : state === "AVAILABLE" ? "The connected TikTok account does not report the music capability." : "Requires a connected TikTok account that reports the music capability.",
      });
    }

    return {
      platform,
      label,
      publishable: publishable.has(platform),
      state,
      reason,
      accounts: {
        connected: confirmed.length,
        reauthRequired: reauth.length,
        pending: pendingProfiles.length,
        disconnected: rows.length - live.length,
      },
      destinations: live.filter((a) => a.socialAccountId !== null).length,
      connectableProfiles,
      features,
    };
  });
}
