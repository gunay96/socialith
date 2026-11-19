#!/usr/bin/env node
/**
 * Repository hygiene gate (CI job `hygiene`, also runnable locally):
 *
 *   node scripts/ci/check-repo-hygiene.mjs            # tracked files only
 *   node scripts/ci/check-repo-hygiene.mjs --history  # + every line ever added on any ref
 *
 * Fails (exit 1) on:
 *   - a tracked env file other than a *.example file, private key, DB dump or backup
 *   - a UTF-8 BOM in files where it breaks tooling (Prisma migrations, shell, yaml, toml)
 *   - CRLF in Prisma migrations or shell scripts (Prisma checksums are byte-exact)
 *   - anything that looks like a real credential (provider token formats, private
 *     key blocks, URL-embedded passwords, long secret-looking assignments)
 *
 * Findings print file/line and the pattern NAME only — never the matched text — so
 * the CI log cannot itself leak a secret. Deliberate fakes (test fixtures, `change-me`
 * placeholders, throwaway local-test credentials) are allow-listed below, narrowly.
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const withHistory = process.argv.includes("--history");

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
}

// ---------------------------------------------------------------- rules --
const FORBIDDEN_TRACKED = [
  { name: "env file", test: (p) => /(^|\/)\.env(\.|$)/.test(p) && !/\.example$/.test(p) },
  { name: "private key / certificate", test: (p) => /\.(pem|key|p12|pfx|keystore)$/i.test(p) || /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/.test(p) },
  { name: "database dump / backup", test: (p) => /\.(sql\.gz|dump|sqlite3?|bak|bundle)$/i.test(p) || /(^|\/)backups\//.test(p) },
];

const BOM_CHECKED = /(^|\/)(prisma\/migrations\/.+|.+\.(sh|ya?ml|toml))$/;
const LF_REQUIRED = /(^|\/)(prisma\/migrations\/.+|.+\.sh)$/;

/** Name → regex. A hit on a non-allow-listed line fails the gate. */
const SECRET_PATTERNS = [
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["Stripe live key", /\b[sr]k_live_[A-Za-z0-9]{16,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["private key block", /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["password inside a URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`<>$]+:(?!\$|<|\{|%|\*+@)[^\s@/'"`<>$]{6,}@(?!localhost\b)[^\s'"`]+/i],
  [
    "secret-looking assignment",
    /\b[A-Za-z0-9_]*(?:client_?secret|api_?key|access_?token|refresh_?token|secret_?key|private_?key|password)[A-Za-z0-9_]*["']?\s*[:=]\s*["']([A-Za-z0-9+/_=-]{24,})["']/i,
  ],
];

/**
 * A line is ignored only if it carries one of these markers. Each is a
 * deliberately fake or throwaway value that exists in the repository on purpose.
 */
const ALLOW_MARKERS = [
  /it-app-throwaway|it-root-throwaway|throwaway/i,
  /change-me|changeme|placeholder|REPLACE_ME|your[-_ ]?(secret|key|token)/i,
  /dev-fake-|not-for-production|NOT_FOR_PRODUCTION|ci-only/i,
  /0123456789abcdef|abababab|integration-test|test-session-secret/i,
  /\$\{[A-Z_]+[:?-]/, // docker-compose / shell parameter expansion
  /process\.env\.|import\.meta\.env\./,
  /example\.(com|org|net)|\.example\b|@socialith\.local|DB-PASSWORD-SENTINEL|Tr0ub4dor/,
];

// scan targets: skip binaries, lockfiles and vendored output
const SKIP_CONTENT = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|.+\.(png|jpe?g|gif|webp|ico|woff2?|ttf|mp4|mov|mp3|wav|zip|gz|bundle|lock|svg))$/i;

const findings = [];
const add = (where, what) => findings.push({ where, what });

// Unit-test files are full of obviously fake literals ("real-shaped-access-token").
// The generic assignment heuristic is skipped for them; every provider-format
// pattern (AWS/GitHub/Slack/Stripe/Google/JWT/private keys/URL passwords) still applies.
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const GENERIC_PATTERN = "secret-looking assignment";

function scanLine(where, line, file) {
  if (line.length > 4000) return; // minified blobs
  if (ALLOW_MARKERS.some((m) => m.test(line))) return;
  const isTest = TEST_FILE.test(file);
  for (const [name, re] of SECRET_PATTERNS) {
    if (isTest && name === GENERIC_PATTERN) continue;
    if (re.test(line)) add(where, `possible secret: ${name}`);
  }
}

// -------------------------------------------------------- tracked files --
const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);

for (const file of tracked) {
  for (const rule of FORBIDDEN_TRACKED) if (rule.test(file)) add(file, `forbidden tracked file: ${rule.name}`);

  let size;
  try {
    size = statSync(file).size;
  } catch {
    continue; // deleted in the working tree
  }
  if (size > 2 * 1024 * 1024 || SKIP_CONTENT.test(file)) continue;

  const buf = readFileSync(file);
  if (buf.includes(0)) continue; // binary

  if (BOM_CHECKED.test(file) && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    add(file, "UTF-8 BOM (breaks Prisma/shell/yaml tooling)");
  }
  if (LF_REQUIRED.test(file) && buf.includes(0x0d)) add(file, "CRLF line endings (must be LF)");

  const text = buf.toString("utf8");
  text.split("\n").forEach((line, i) => scanLine(`${file}:${i + 1}`, line, file));
}

// -------------------------------------------------------------- history --
async function scanHistory() {
  await new Promise((resolve, reject) => {
    const proc = spawn("git", ["log", "--all", "-p", "-U0", "--no-color", "--format=commit %h", "--text"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let commit = "?";
    let file = "?";
    let tail = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      const lines = (tail + chunk).split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) handle(line);
    });
    function handle(line) {
      if (line.startsWith("commit ")) commit = line.slice(7, 20);
      else if (line.startsWith("+++ b/")) file = line.slice(6);
      else if (line.startsWith("+") && !line.startsWith("+++") && !SKIP_CONTENT.test(file)) {
        scanLine(`history ${commit}:${file}`, line.slice(1), file);
        for (const rule of FORBIDDEN_TRACKED) {
          if (line === `+++ b/${file}` && rule.test(file)) add(`history ${commit}:${file}`, `forbidden file once committed: ${rule.name}`);
        }
      }
    }
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (tail) handle(tail);
      code === 0 ? resolve() : reject(new Error(`git log exited ${code}`));
    });
  });
  // files that were ever added (even if later deleted)
  const added = git(["log", "--all", "--diff-filter=A", "--name-only", "--format=commit %h", "--no-color"]).split("\n");
  let commit = "?";
  for (const line of added) {
    if (line.startsWith("commit ")) commit = line.slice(7);
    else if (line)
      for (const rule of FORBIDDEN_TRACKED) if (rule.test(line)) add(`history ${commit}:${line}`, `forbidden file once committed: ${rule.name}`);
  }
}

if (withHistory) await scanHistory();

// --------------------------------------------------------------- report --
const unique = [...new Map(findings.map((f) => [`${f.where}|${f.what}`, f])).values()];
if (unique.length === 0) {
  console.log(`repo hygiene: OK (${tracked.length} tracked files${withHistory ? ", full history" : ""})`);
} else {
  console.error(`repo hygiene: ${unique.length} problem(s)`);
  for (const f of unique) console.error(`  ${f.where}  —  ${f.what}`);
  process.exit(1);
}
