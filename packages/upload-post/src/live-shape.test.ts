import { describe, expect, it } from "vitest";
import { normalizeMe, normalizeProfile, normalizeProfileList } from "./normalize.js";

/**
 * Fixtures below are the SANITIZED shapes observed LIVE on 2026-11-20 (a trial account: plan "Default", limit 2,
 * one profile, no connected social account). Only names/values that identify the owner were replaced; field names,
 * types and nesting are exactly what the provider returned. They pin the "empty account" reality that a paid,
 * fully connected plan would never show.
 */
const LIVE_ME = {
  success: true,
  message: "ok",
  email: "owner@example.com",
  plan: "Default",
  preferences: {},
  attribution: {},
  x_links: { entitled: false, source: null, monthly_cap: 0, used: 0, remaining: 0 },
  analyze_shorts: { limit: 10, used: 0, remaining: 10, resets_at: null },
};

const LIVE_USERS = {
  success: true,
  profiles: [{ username: "example_profile", social_accounts: { tiktok: "" }, created_at: "Thu, 20 Nov 2026 10:00:00 GMT", blocked: false, display_name: null }],
  limit: 2,
  plan: "default",
};

describe("live response shapes (trial account, nothing connected)", () => {
  it("GET /me: plan name is kept as reported; an analyze_shorts window that never started has no reset date", () => {
    expect(normalizeMe(LIVE_ME)).toEqual({
      email: "owner@example.com",
      plan: "Default",
      weekStartDay: null,
      analyzeShorts: { limit: 10, used: 0, remaining: 10, resetsAt: null },
    });
  });

  it("GET /users: one profile whose only platform key is an empty string = NOT connected (and not pending)", () => {
    const list = normalizeProfileList(LIVE_USERS);
    expect(list.profileLimit).toBe(2); // the plan's real limit, not 225
    expect(list.plan).toBe("default");
    expect(list.profiles).toHaveLength(1);
    const p = list.profiles[0]!;
    expect(p).toMatchObject({ username: "example_profile", displayName: null, blocked: false, accounts: [], pendingPlatforms: [] });
    expect(p.createdAt?.toISOString()).toBe("2026-11-20T10:00:00.000Z");
  });

  it("never invents a connected account from empty platform entries", () => {
    for (const social of [{ tiktok: "" }, { tiktok: "", instagram: "", youtube: "" }, {}, { tiktok: null }, undefined, null, "" as unknown]) {
      const p = normalizeProfile({ username: "p", social_accounts: social });
      expect(p, JSON.stringify(social)).not.toBeNull();
      expect(p!.accounts).toEqual([]);
      expect(p!.pendingPlatforms).toEqual([]);
    }
  });

  it("an empty profile list is a valid answer (limit and plan are still reported)", () => {
    expect(normalizeProfileList({ success: true, profiles: [], limit: 2, plan: "default" })).toEqual({ profileLimit: 2, plan: "default", profiles: [] });
    expect(normalizeProfileList({ success: true, limit: 2, plan: "default" }).profiles).toEqual([]);
  });

  it("`blocked` is read strictly: only `true` blocks; absent/false/garbage do not", () => {
    const base = { username: "p", social_accounts: {} };
    expect(normalizeProfile({ ...base, blocked: true })!.blocked).toBe(true);
    for (const v of [false, undefined, null, "true", 1]) expect(normalizeProfile({ ...base, blocked: v })!.blocked).toBe(false);
  });

  it("a platform object without a stable id is pending, an object with one is connected (mixed with empty entries)", () => {
    const p = normalizeProfile({
      username: "p",
      social_accounts: { tiktok: "", instagram: { username: "17841400000000000", handle: "my.band", reauth_required: false }, youtube: { handle: "no-id-yet" } },
    })!;
    expect(p.accounts.map((a) => [a.platform, a.providerAccountId])).toEqual([["instagram", "17841400000000000"]]);
    expect(p.pendingPlatforms).toEqual(["youtube"]);
  });
});
