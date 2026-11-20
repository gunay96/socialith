import { describe, expect, it } from "vitest";
import { derivePlatformAvailability, type CapabilityProfileInput } from "./upload-post-capabilities.js";

const profile = (over: Partial<CapabilityProfileInput> = {}): CapabilityProfileInput => ({ id: "p1", username: "example_profile", status: "ACTIVE", blocked: false, pendingPlatforms: [], accounts: [], ...over });
const byPlatform = (rows: ReturnType<typeof derivePlatformAvailability>) => Object.fromEntries(rows.map((r) => [r.platform, r]));

describe("derivePlatformAvailability", () => {
  it("the live trial state (one profile, nothing connected): every publishable platform is UNAVAILABLE, none is simulated", () => {
    const r = byPlatform(derivePlatformAvailability({ synced: true, profiles: [profile()] }));
    expect(Object.keys(r)).toEqual(["tiktok", "instagram", "youtube"]);
    for (const p of Object.values(r)) {
      expect(p.state).toBe("UNAVAILABLE");
      expect(p.accounts).toEqual({ connected: 0, reauthRequired: 0, pending: 0, disconnected: 0 });
      expect(p.destinations).toBe(0);
      expect(p.publishable).toBe(true);
      expect(p.reason).toMatch(/not confirmed access|has not confirmed access/);
      // the free slot is surfaced so the owner knows where to connect it
      expect(p.connectableProfiles).toEqual([{ id: "p1", username: "example_profile" }]);
    }
    expect(r.tiktok!.features).toEqual([expect.objectContaining({ key: "music", state: "UNAVAILABLE" })]);
  });

  it("no data at all: everything UNAVAILABLE, with a reason that says why", () => {
    const never = derivePlatformAvailability({ synced: false, profiles: [] });
    expect(never.every((p) => p.state === "UNAVAILABLE" && /not been synchronized/.test(p.reason ?? ""))).toBe(true);
    const empty = derivePlatformAvailability({ synced: true, profiles: [] });
    expect(empty.every((p) => p.state === "UNAVAILABLE" && /No Upload-Post profile exists/.test(p.reason ?? ""))).toBe(true);
    expect(empty.every((p) => p.connectableProfiles.length === 0)).toBe(true);
  });

  it("Instagram and YouTube become AVAILABLE when connected while TikTok stays UNAVAILABLE", () => {
    const r = byPlatform(
      derivePlatformAvailability({
        synced: true,
        profiles: [profile({ accounts: [{ platform: "instagram", status: "CONNECTED", socialAccountId: null, capabilities: [] }, { platform: "youtube", status: "CONNECTED", socialAccountId: "sa1", capabilities: [] }] })],
      }),
    );
    expect(r.instagram).toMatchObject({ state: "AVAILABLE", reason: null, accounts: { connected: 1 }, destinations: 0, connectableProfiles: [] });
    expect(r.youtube).toMatchObject({ state: "AVAILABLE", destinations: 1 });
    expect(r.tiktok!.state).toBe("UNAVAILABLE");
    expect(r.tiktok!.features[0]).toMatchObject({ state: "UNAVAILABLE" });
  });

  it("TikTok music is available only for a connected account that reports the music capability", () => {
    const withMusic = byPlatform(derivePlatformAvailability({ synced: true, profiles: [profile({ accounts: [{ platform: "tiktok", status: "CONNECTED", socialAccountId: null, capabilities: ["music", "draft"] }] })] }));
    expect(withMusic.tiktok).toMatchObject({ state: "AVAILABLE" });
    expect(withMusic.tiktok!.features[0]).toMatchObject({ state: "AVAILABLE", reason: null });
    const without = byPlatform(derivePlatformAvailability({ synced: true, profiles: [profile({ accounts: [{ platform: "tiktok", status: "CONNECTED", socialAccountId: null, capabilities: [] }] })] }));
    expect(without.tiktok!.state).toBe("AVAILABLE");
    expect(without.tiktok!.features[0]!.reason).toMatch(/does not report the music capability/);
  });

  it("reauth, pending, disconnected, removed and blocked are never reported as available", () => {
    const r = byPlatform(
      derivePlatformAvailability({
        synced: true,
        profiles: [
          profile({ id: "a", username: "a", accounts: [{ platform: "tiktok", status: "REAUTH_REQUIRED", socialAccountId: null, capabilities: ["music"] }], pendingPlatforms: ["instagram"] }),
          profile({ id: "b", username: "b", accounts: [{ platform: "youtube", status: "DISCONNECTED", socialAccountId: null, capabilities: [] }] }),
          profile({ id: "c", username: "c", status: "REMOVED", accounts: [{ platform: "instagram", status: "CONNECTED", socialAccountId: null, capabilities: [] }] }),
        ],
      }),
    );
    expect(r.tiktok).toMatchObject({ state: "REAUTH_REQUIRED", accounts: { connected: 0, reauthRequired: 1 } });
    expect(r.tiktok!.features[0]!.state).toBe("UNAVAILABLE");
    expect(r.instagram).toMatchObject({ state: "PENDING", accounts: { pending: 1 } });
    expect(r.youtube).toMatchObject({ state: "UNAVAILABLE", accounts: { disconnected: 1, connected: 0 } });

    const blocked = byPlatform(derivePlatformAvailability({ synced: true, profiles: [profile({ blocked: true, accounts: [{ platform: "youtube", status: "CONNECTED", socialAccountId: null, capabilities: [] }] })] }));
    expect(blocked.youtube!.state).toBe("UNAVAILABLE");
    expect(blocked.youtube!.reason).toMatch(/blocked/);
    expect(blocked.tiktok!.connectableProfiles).toEqual([]); // a blocked profile is not offered as a place to connect
  });

  it("non-publishable platforms seen in a profile are listed as sync-only", () => {
    const r = byPlatform(derivePlatformAvailability({ synced: true, profiles: [profile({ accounts: [{ platform: "facebook", status: "CONNECTED", socialAccountId: null, capabilities: [] }] })] }));
    expect(r.facebook).toMatchObject({ publishable: false, state: "AVAILABLE", label: "Facebook" });
  });
});
