import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Node's built-in `crypto.scrypt` — deliberately not argon2: this
 * project targets shared cPanel hosting (Güzel Hosting) where `argon2`'s
 * prebuilt native binary requires GLIBC_2.34 and the account has no
 * working C++ toolchain to compile it from source (verified: gcc isn't
 * runnable from the app's own user account) — ERR_DLOPEN_FAILED at
 * import time, unrecoverable without a VPS. scrypt is memory-hard like
 * Argon2id and ships in Node core, so it needs zero native compilation
 * anywhere.
 *
 * N/r/p chosen for a shared-hosting-appropriate memory ceiling: Node's
 * own scrypt memory requirement is ~128 * N * r bytes, so N=16384, r=8
 * costs ~16 MiB per hash (well under Node's 32 MiB default `maxmem`,
 * and low enough that a few concurrent logins on constrained shared
 * hosting won't exhaust memory) while still being well above scrypt's
 * historical minimum-security thresholds. `maxmem` is passed explicitly
 * anyway, computed from N/r, rather than relying on Node's default
 * matching these numbers by coincidence.
 */
const SCRYPT_PARAMS = {
  N: 16384,
  r: 8,
  p: 1,
  keylen: 64,
  saltBytes: 16,
} as const;

const FORMAT_PREFIX = "scrypt";
const FORMAT_VERSION = "v1";

function maxmemFor(N: number, r: number): number {
  // 2x the documented ~128*N*r requirement as headroom, not a magic
  // number — see this file's top comment.
  return 128 * N * r * 2;
}

function encodeHash(N: number, r: number, p: number, salt: Buffer, derived: Buffer): string {
  return [FORMAT_PREFIX, FORMAT_VERSION, N, r, p, salt.toString("base64"), derived.toString("base64")].join("$");
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  derived: Buffer;
}

/**
 * Returns null for anything that isn't a well-formed `scrypt$v1$...`
 * hash — including a pre-migration Argon2id hash (`$argon2id$...`), if
 * one somehow reached this code path. There is no dual-format
 * verification path: this project has never had a real production user
 * (see this repo's migration report), so every stored hash is expected
 * to already be in this format by the time this ships. A malformed/
 * unrecognized hash safely fails closed via verifyPassword returning
 * false, the same as a wrong password — never a thrown error a caller
 * might mishandle into an accidental bypass.
 */
function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 7) return null;
  // Non-null: the length check above guarantees all 7 elements exist —
  // TS's array-destructuring can't narrow that from a plain string[].
  const [prefix, version, nRaw, rRaw, pRaw, saltB64, derivedB64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (prefix !== FORMAT_PREFIX || version !== FORMAT_VERSION) return null;

  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return null;

  let salt: Buffer;
  let derived: Buffer;
  try {
    salt = Buffer.from(saltB64, "base64");
    derived = Buffer.from(derivedB64, "base64");
  } catch {
    return null;
  }
  if (salt.length === 0 || derived.length === 0) return null;

  return { N, r, p, salt, derived };
}

export async function hashPassword(plainPassword: string): Promise<string> {
  const { N, r, p, keylen, saltBytes } = SCRYPT_PARAMS;
  const salt = randomBytes(saltBytes);
  const derived = await scrypt(plainPassword, salt, keylen, { N, r, p, maxmem: maxmemFor(N, r) });
  return encodeHash(N, r, p, salt, derived);
}

/**
 * Verifies a password against a stored scrypt hash. Never throws on a
 * mismatched password, a malformed hash, or an out-of-range parameter
 * that would make Node's scrypt itself throw — only ever returns
 * true/false, so callers can treat every non-match case identically
 * (this is what auth.service.ts's dummy-hash timing defense against
 * user enumeration relies on). Re-derives using the N/r/p/keylen
 * recorded *in the stored hash itself*, not today's SCRYPT_PARAMS
 * constant — the whole point of encoding them per-hash — so a future
 * change to SCRYPT_PARAMS (a cost bump, say) never breaks verification
 * of hashes created under the old parameters.
 */
export async function verifyPassword(hash: string, plainPassword: string): Promise<boolean> {
  const parsed = parseHash(hash);
  if (!parsed) return false;
  try {
    const derived = await scrypt(plainPassword, parsed.salt, parsed.derived.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: maxmemFor(parsed.N, parsed.r),
    });
    // Buffers are guaranteed equal length (derived using parsed.derived.length
    // as keylen above) — timingSafeEqual throws on a length mismatch, which
    // can't happen here, but the check is left explicit rather than relying
    // on that invariant silently.
    if (derived.length !== parsed.derived.length) return false;
    return timingSafeEqual(derived, parsed.derived);
  } catch {
    return false;
  }
}
