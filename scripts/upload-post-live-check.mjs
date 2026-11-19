#!/usr/bin/env node
/**
 * READ-ONLY live check of the Upload-Post credentials and account state. Run by the project owner on a machine
 * where UPLOAD_POST_API_KEY is configured:
 *
 *   node scripts/upload-post-live-check.mjs
 *
 * It performs exactly two GET requests — /uploadposts/me and /uploadposts/users — and prints a redacted summary.
 * It never publishes, creates, edits or deletes anything. The key is read from the environment (or the git-ignored
 * .env in the current directory), is sent only in the Authorization header to the configured Upload-Post base URL,
 * and is never printed. Exit code 0 = both calls succeeded, 1 = a call failed, 2 = not configured.
 */
import { existsSync, readFileSync } from "node:fs";

function readDotEnv() {
  if (!existsSync(".env")) return {};
  const out = {};
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(UPLOAD_POST_[A-Z_]+)\s*=\s*"?([^"#\r\n]*)"?\s*$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const fileEnv = readDotEnv();
const key = process.env.UPLOAD_POST_API_KEY || fileEnv.UPLOAD_POST_API_KEY;
const base = (process.env.UPLOAD_POST_BASE_URL || fileEnv.UPLOAD_POST_BASE_URL || "https://api.upload-post.com/api").replace(/\/+$/, "");

if (!key) {
  console.error("UPLOAD_POST_API_KEY is not set (environment or local .env). Nothing was sent.");
  process.exit(2);
}
if (!base.startsWith("https://")) {
  console.error("Refusing to send the key over a non-https base URL.");
  process.exit(2);
}

const mask = (s) => (s ? `${String(s).slice(0, 2)}***${String(s).slice(-4)}` : "-");
const maskEmail = (e) => (e ? e.replace(/^(.).*(@.*)$/, "$1***$2") : "-");

async function get(path) {
  const started = Date.now();
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Apikey ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, ms: Date.now() - started, body, text };
}

let failed = false;

const me = await get("/uploadposts/me");
console.log(`GET /uploadposts/me        -> HTTP ${me.status} in ${me.ms} ms`);
if (me.status === 200 && me.body) {
  console.log(`  plan: ${me.body.plan ?? "?"}   account: ${maskEmail(me.body.email)}   analyze_shorts: ${me.body.analyze_shorts ? `${me.body.analyze_shorts.used}/${me.body.analyze_shorts.limit}` : "n/a"}`);
} else {
  failed = true;
  console.log(`  message: ${String(me.body?.message ?? me.text).slice(0, 200).replaceAll(key, "[redacted]")}`);
}

const users = await get("/uploadposts/users");
console.log(`GET /uploadposts/users     -> HTTP ${users.status} in ${users.ms} ms`);
if (users.status === 200 && users.body) {
  const profiles = Array.isArray(users.body.profiles) ? users.body.profiles : [];
  console.log(`  plan: ${users.body.plan ?? "?"}   profile limit (reported by the provider): ${users.body.limit ?? "?"}   profiles: ${profiles.length}`);
  const byPlatform = {};
  let reauth = 0;
  let pending = 0;
  for (const p of profiles) {
    for (const [platform, acc] of Object.entries(p.social_accounts ?? {})) {
      if (platform.endsWith("_pending")) { if (acc) pending++; continue; }
      if (acc && typeof acc === "object" && acc.username) {
        byPlatform[platform] = (byPlatform[platform] ?? 0) + 1;
        if (acc.reauth_required) reauth++;
      }
    }
  }
  console.log(`  connected accounts by platform: ${JSON.stringify(byPlatform)}   needing reauthorization: ${reauth}   pending: ${pending}`);
  for (const p of profiles.slice(0, 5)) console.log(`  - profile ${mask(p.username)} (${p.display_name ?? "no display name"}): ${Object.keys(p.social_accounts ?? {}).filter((k) => p.social_accounts[k] && typeof p.social_accounts[k] === "object").join(", ") || "no accounts"}`);
  if (profiles.length > 5) console.log(`  ... and ${profiles.length - 5} more`);
} else {
  failed = true;
  console.log(`  message: ${String(users.body?.message ?? users.text).slice(0, 200).replaceAll(key, "[redacted]")}`);
}

console.log(failed ? "\nLIVE CHECK FAILED (see above)." : "\nLive read-only check passed. Compare the shapes with docs/UPLOAD_POST_API_MAPPING.md and record the date in docs/UPLOAD_POST_TESTING.md.");
process.exit(failed ? 1 : 0);
