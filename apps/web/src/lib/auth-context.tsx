"use client";

import { createContext, useContext } from "react";
import type { SafeUser } from "@/lib/api";

/**
 * The authenticated user, provided once by the (app) shell layout after
 * its single /api/auth/me check — pages inside the shell read it from
 * here instead of each re-fetching /me themselves (team/page.tsx did
 * this on its own in Phase 02D, before the shell existed).
 */
const CurrentUserContext = createContext<SafeUser | null>(null);

export const CurrentUserProvider = CurrentUserContext.Provider;

export function useCurrentUser(): SafeUser {
  const user = useContext(CurrentUserContext);
  if (!user) {
    throw new Error("useCurrentUser() called outside the (app) shell layout.");
  }
  return user;
}
