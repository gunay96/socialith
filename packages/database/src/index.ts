import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __socialithPrisma: PrismaClient | undefined;
}

/**
 * Shared Prisma client instance.
 * Reused across hot-reloads in dev to avoid exhausting DB connections.
 */
export const prisma =
  global.__socialithPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV === "development") {
  global.__socialithPrisma = prisma;
}

export * from "@prisma/client";
