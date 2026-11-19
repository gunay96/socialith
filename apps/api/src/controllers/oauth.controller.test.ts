import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const { userMock, connectAccountMock } = vi.hoisted(() => ({
  userMock: {
    id: "user_1",
    organizationId: "org_1",
    name: "Editor",
    email: "editor@example.com",
    passwordHash: "irrelevant",
    role: "EDITOR",
    status: "ACTIVE",
    sessionVersion: 0,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  connectAccountMock: vi.fn(),
}));

vi.mock("@socialith/database", () => ({
  prisma: { user: { findUnique: async () => userMock } },
}));

vi.mock("@socialith/config", () => ({
  loadEnv: vi.fn(() => ({
    NODE_ENV: "test",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    SESSION_SECRET: "a-long-enough-test-only-secret",
    TIKTOK_CLIENT_KEY: "test-client-key",
    TIKTOK_CLIENT_SECRET: "test-client-secret",
  })),
  resolveAppOrigin: vi.fn(() => "http://localhost:3000"),
  resolveOAuthRedirectUri: vi.fn(() => "http://localhost:4000/api/oauth/tiktok/callback"),
}));

vi.mock("../services/social-account.service.js", () => ({
  connectAccount: connectAccountMock,
}));

const { createOAuthRouter } = await import("../routes/oauth.js");
const { createSessionMiddleware, establishSession, regenerateSession } = await import("../lib/session.js");
const { errorHandler, notFoundHandler } = await import("../middleware/error-handler.js");

function buildApp() {
  const app = express();
  app.use(createSessionMiddleware({ SESSION_SECRET: "a-long-enough-test-only-secret", NODE_ENV: "test" }));

  app.post("/test/login-as", async (req, res) => {
    await regenerateSession(req);
    establishSession(req, { id: userMock.id, organizationId: userMock.organizationId, role: "EDITOR", sessionVersion: 0 });
    res.status(200).json({ ok: true });
  });

  // A minimal no-op limiter — the real Redis-backed one is tested separately (middleware/rate-limit.test.ts).
  const noopLimiter: express.RequestHandler = (_req, _res, next) => next();
  app.use("/api", createOAuthRouter(noopLimiter));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

async function loginAgent(app: express.Express) {
  const agent = request.agent(app);
  await agent.post("/test/login-as");
  return agent;
}

const TIKTOK_TOKEN_RESPONSE = {
  access_token: "real-shaped-access-token",
  refresh_token: "real-shaped-refresh-token",
  expires_in: 86400,
  scope: "user.info.basic,video.list,video.upload",
};

const TIKTOK_USER_INFO_RESPONSE = {
  data: {
    user: {
      open_id: "tiktok_open_id_abc123",
      display_name: "Test Creator",
      username: "testcreator",
      avatar_url: "https://p16-sign.tiktokcdn.com/avatar.jpg",
      follower_count: 4200,
    },
  },
  error: { code: "ok", message: "" },
};

beforeEach(() => {
  connectAccountMock.mockReset();
  connectAccountMock.mockResolvedValue({ id: "acct_1", platform: "TIKTOK" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/oauth/:platform/start", () => {
  it("requires authentication", async () => {
    const res = await request(buildApp()).get("/api/oauth/tiktok/start");
    expect(res.status).toBe(401);
  });

  it("generates a real, cryptographically-random state, stores it in the session, and redirects to TikTok's real authorize URL", async () => {
    const app = buildApp();
    const agent = await loginAgent(app);

    const res = await agent.get("/api/oauth/tiktok/start").redirects(0);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(location.searchParams.get("client_key")).toBe("test-client-key");
    expect(location.searchParams.get("scope")).toBe("user.info.basic,user.info.profile,user.info.stats,video.list,video.upload");
    const state = location.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(state!.length).toBeGreaterThanOrEqual(32); // real base64url-encoded 32 random bytes, not a short/predictable value
  });

  it("includes a real PKCE code_challenge (S256) on TikTok's authorize URL — its live endpoint rejects requests without one", async () => {
    const app = buildApp();
    const agent = await loginAgent(app);

    const res = await agent.get("/api/oauth/tiktok/start").redirects(0);
    const location = new URL(res.headers.location);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    const codeChallenge = location.searchParams.get("code_challenge");
    expect(codeChallenge).toBeTruthy();
    expect(codeChallenge!.length).toBeGreaterThanOrEqual(32); // a real SHA-256-derived value, not a placeholder
  });

  it("generates a different state on every call (never reused/predictable)", async () => {
    const app = buildApp();
    const agent = await loginAgent(app);

    const first = await agent.get("/api/oauth/tiktok/start").redirects(0);
    const second = await agent.get("/api/oauth/tiktok/start").redirects(0);
    const stateA = new URL(first.headers.location).searchParams.get("state");
    const stateB = new URL(second.headers.location).searchParams.get("state");
    expect(stateA).not.toBe(stateB);
  });

  it("returns a real CONFIGURATION_ERROR (never a fabricated authorization URL) when TikTok app credentials aren't configured", async () => {
    const { loadEnv } = await import("@socialith/config");
    (loadEnv as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      NODE_ENV: "test",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      SESSION_SECRET: "a-long-enough-test-only-secret",
      // no TIKTOK_CLIENT_KEY/SECRET
    });
    const app = buildApp();
    const agent = await loginAgent(app);

    const res = await agent.get("/api/oauth/tiktok/start");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CONFIGURATION_ERROR");
  });
});

describe("GET /api/oauth/:platform/callback", () => {
  it("rejects a callback with no prior /start (no session state at all) as invalid_state", async () => {
    const app = buildApp();
    const agent = await loginAgent(app);

    const res = await agent.get("/api/oauth/tiktok/callback?code=abc&state=whatever").redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("oauthError=invalid_state");
    expect(connectAccountMock).not.toHaveBeenCalled();
  });

  it("rejects a callback whose state doesn't match the one issued by /start", async () => {
    const app = buildApp();
    const agent = await loginAgent(app);
    const startRes = await agent.get("/api/oauth/tiktok/start").redirects(0);
    const realState = new URL(startRes.headers.location).searchParams.get("state")!;

    const res = await agent.get(`/api/oauth/tiktok/callback?code=abc&state=${realState}-tampered`).redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("oauthError=invalid_state");
  });

  it("rejects a replayed callback — the same state can't be used twice", async () => {
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("/oauth/token/")) return new Response(JSON.stringify(TIKTOK_TOKEN_RESPONSE), { status: 200 });
      if (u.includes("/user/info/")) return new Response(JSON.stringify(TIKTOK_USER_INFO_RESPONSE), { status: 200 });
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const app = buildApp();
    const agent = await loginAgent(app);
    const startRes = await agent.get("/api/oauth/tiktok/start").redirects(0);
    const realState = new URL(startRes.headers.location).searchParams.get("state")!;

    const first = await agent.get(`/api/oauth/tiktok/callback?code=real-code&state=${realState}`).redirects(0);
    expect(first.headers.location).toContain("connected=TIKTOK");
    expect(connectAccountMock).toHaveBeenCalledTimes(1);

    const replay = await agent.get(`/api/oauth/tiktok/callback?code=real-code&state=${realState}`).redirects(0);
    expect(replay.headers.location).toContain("oauthError=invalid_state");
    expect(connectAccountMock).toHaveBeenCalledTimes(1); // still 1 — the replay never reached connectAccount again
  });

  it("rejects a state older than the 10-minute window as expired/invalid", async () => {
    vi.useFakeTimers();
    const app = buildApp();
    const agent = await loginAgent(app);
    const startRes = await agent.get("/api/oauth/tiktok/start").redirects(0);
    const realState = new URL(startRes.headers.location).searchParams.get("state")!;

    vi.advanceTimersByTime(11 * 60 * 1000); // past the 10-minute STATE_MAX_AGE_MS

    const res = await agent.get(`/api/oauth/tiktok/callback?code=abc&state=${realState}`).redirects(0);
    expect(res.headers.location).toContain("oauthError=invalid_state");
    vi.useRealTimers();
  });

  it("redirects with access_denied (a real, expected outcome, not an error) when the user declines TikTok's consent screen", async () => {
    const app = buildApp();
    const agent = await loginAgent(app);
    await agent.get("/api/oauth/tiktok/start").redirects(0);

    const res = await agent.get("/api/oauth/tiktok/callback?error=access_denied").redirects(0);
    expect(res.headers.location).toContain("oauthError=access_denied");
    expect(connectAccountMock).not.toHaveBeenCalled();
  });

  it("on success: exchanges the code server-side, fetches account metadata, calls connectAccount, and never returns a token to the browser", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("/oauth/token/")) return new Response(JSON.stringify(TIKTOK_TOKEN_RESPONSE), { status: 200 });
      if (u.includes("/user/info/")) return new Response(JSON.stringify(TIKTOK_USER_INFO_RESPONSE), { status: 200 });
      throw new Error(`unexpected fetch: ${u}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const app = buildApp();
    const agent = await loginAgent(app);
    const startRes = await agent.get("/api/oauth/tiktok/start").redirects(0);
    const realState = new URL(startRes.headers.location).searchParams.get("state")!;
    const realCodeChallenge = new URL(startRes.headers.location).searchParams.get("code_challenge")!;

    const res = await agent.get(`/api/oauth/tiktok/callback?code=real-auth-code&state=${realState}`).redirects(0);

    // The code_verifier actually sent to TikTok's token endpoint must be
    // the one whose SHA-256/base64url hash matches the code_challenge
    // /start sent earlier — proves the server round-trips the *same*
    // PKCE pair end-to-end, not just that some code_verifier was sent.
    const tokenCall = fetchMock.mock.calls.find(([u]) => u.toString().includes("/oauth/token/"))!;
    const sentBody = new URLSearchParams((tokenCall[1] as RequestInit).body as string);
    const { computePkceChallenge } = await import("@socialith/auth");
    expect(computePkceChallenge(sentBody.get("code_verifier")!)).toBe(realCodeChallenge);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/accounts");
    expect(res.headers.location).toContain("connected=TIKTOK");
    // No token anywhere in the response — neither the redirect Location nor a body.
    expect(res.headers.location).not.toContain("real-shaped-access-token");
    expect(res.text ?? "").not.toContain("real-shaped-access-token");

    expect(connectAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user_1", organizationId: "org_1" }),
      expect.objectContaining({
        platform: "TIKTOK",
        externalAccountId: "tiktok_open_id_abc123",
        handle: "@testcreator",
        accessToken: "real-shaped-access-token",
        refreshToken: "real-shaped-refresh-token",
        scopes: ["user.info.basic", "video.list", "video.upload"],
      }),
    );
  });

  it("real TikTok token-exchange failure (e.g. an already-used/invalid authorization code) redirects with a platform error, never a fabricated success", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Authorization code has expired." }), { status: 400 }),
    ) as unknown as typeof fetch;

    const app = buildApp();
    const agent = await loginAgent(app);
    const startRes = await agent.get("/api/oauth/tiktok/start").redirects(0);
    const realState = new URL(startRes.headers.location).searchParams.get("state")!;

    const res = await agent.get(`/api/oauth/tiktok/callback?code=expired-code&state=${realState}`).redirects(0);
    expect(res.headers.location).toContain("oauthError=");
    expect(connectAccountMock).not.toHaveBeenCalled();
  });
});
