import { EnvValidationError, parseEnv, type Env } from "@socialith/config";

/**
 * Explicit production-environment validation for destructive-by-nature
 * one-time commands. Runs BEFORE the password is read and BEFORE the
 * database is touched. Refuses unless ALL of the following hold:
 *
 *  - NODE_ENV is literally "production" (parseEnv would default it to
 *    "development", so this is checked on the raw environment first);
 *  - the whole application configuration validates (this is where the
 *    production-only rules live: non-localhost public URLs, secrets, ...);
 *  - NEXT_PUBLIC_APP_URL is https;
 *  - the operator typed the application's own hostname via
 *    --confirm-domain, proving they are aiming at the intended deployment.
 */

export class ProductionGateError extends Error {
  constructor(
    message: string,
    public readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "ProductionGateError";
  }
}

export function assertProductionEnvironment(
  rawEnv: NodeJS.ProcessEnv,
  confirmDomain: string | undefined,
): { env: Env; hostname: string } {
  if (rawEnv.NODE_ENV !== "production") {
    throw new ProductionGateError(
      'Refusing to run: NODE_ENV is not "production". This command initializes a PRODUCTION database; it is not for development (use the seed there).',
    );
  }

  let env: Env;
  try {
    env = parseEnv(rawEnv);
  } catch (err) {
    if (err instanceof EnvValidationError) {
      throw new ProductionGateError(
        "Refusing to run: the environment configuration is invalid.",
        err.issues.map((i) => `${i.path || "(root)"}: ${i.message}`),
      );
    }
    throw err;
  }

  let appUrl: URL;
  try {
    appUrl = new URL(env.NEXT_PUBLIC_APP_URL ?? "");
  } catch {
    throw new ProductionGateError("Refusing to run: NEXT_PUBLIC_APP_URL is not a valid URL.");
  }
  if (appUrl.protocol !== "https:") {
    throw new ProductionGateError("Refusing to run: NEXT_PUBLIC_APP_URL must be https in production.");
  }

  if (!confirmDomain) {
    throw new ProductionGateError(
      `Refusing to run: pass --confirm-domain ${appUrl.hostname} to confirm you are targeting this deployment.`,
    );
  }
  if (confirmDomain.trim().toLowerCase() !== appUrl.hostname.toLowerCase()) {
    throw new ProductionGateError(
      "Refusing to run: --confirm-domain does not match this deployment's NEXT_PUBLIC_APP_URL hostname.",
    );
  }

  return { env, hostname: appUrl.hostname };
}
