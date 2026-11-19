/**
 * Retry for the "lost upsert race" on MySQL.
 *
 * MySQL has no native Prisma `upsert` (Postgres does, as one atomic
 * statement), so two simultaneous callbacks for the same external account
 * can both see "no row", both INSERT, and the loser fails with a unique
 * violation (P2002); heavier contention can also surface as a deadlock /
 * write conflict (P2034). Neither means the operation is wrong — re-running
 * it from scratch finds the row the winner just committed and updates it.
 *
 * ONLY wrap a whole self-contained operation whose unique constraints are
 * the upsert keys themselves (OAuth connect: `(organizationId, platform,
 * externalAccountId)` and `PlatformConnection.socialAccountId`). It is not
 * a general "ignore duplicate errors" tool — a genuinely conflicting insert
 * (a duplicate e-mail) would simply fail the same way again and be rethrown
 * after the last attempt.
 */
const RETRYABLE_PRISMA_CODES = new Set(["P2002", "P2034"]);

export function isUpsertRaceError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code = (err as { code: unknown }).code;
  return typeof code === "string" && RETRYABLE_PRISMA_CODES.has(code);
}

export interface RetryOptions {
  /** Total attempts including the first (default 4). */
  attempts?: number;
  /** Base back-off in ms; attempt n waits ~n × base plus jitter (default 15). */
  baseDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export async function withUpsertRaceRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 4;
  const base = options.baseDelayMs ?? 15;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isUpsertRaceError(err) || attempt >= attempts) throw err;
      // Jitter so the contenders do not collide again in lock-step.
      await sleep(base * attempt + Math.floor(Math.random() * base));
    }
  }
}
