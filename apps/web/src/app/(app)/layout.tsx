"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { apiGet, apiPost, ApiError, type SafeUser } from "@/lib/api";
import { CurrentUserProvider } from "@/lib/auth-context";

function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      className={`rounded px-3 py-2 text-sm ${
        active ? "bg-accent/15 text-foreground" : "text-muted hover:text-foreground"
      }`}
    >
      {label}
    </Link>
  );
}

export default function AppShellLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<SafeUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<SafeUser>("/api/auth/me")
      .then(setUser)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          router.push("/login");
          return;
        }
        setError(err instanceof ApiError ? err.message : "Something went wrong.");
      });
  }, [router]);

  async function handleLogout() {
    await apiPost("/api/auth/logout").catch(() => {
      /* best-effort — redirect regardless, requireAuth will reject a stale session anyway */
    });
    router.push("/login");
  }

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <p className="text-sm text-red-400">{error}</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <p className="text-sm text-muted">Loading…</p>
      </main>
    );
  }

  return (
    <CurrentUserProvider value={user}>
      <div className="flex min-h-screen">
        <aside className="flex w-56 shrink-0 flex-col justify-between border-r border-border bg-surface p-4">
          <div className="flex flex-col gap-1">
            <div className="mb-4 px-3 text-sm font-semibold tracking-tight">SOCIALITH</div>
            <NavLink href="/" label="Dashboard" />
            <NavLink href="/accounts" label="Accounts" />
            <NavLink href="/campaigns" label="Campaigns" />
            <NavLink href="/content" label="Content" />
            <NavLink href="/sounds" label="Music / Sounds" />
            <NavLink href="/publishing" label="Publishing Center" />
            <NavLink href="/upload-post" label="Upload-Post" />
            <NavLink href="/team" label="Team" />
          </div>
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <p className="truncate px-3 text-xs text-muted">
              {user.name} — {user.role}
            </p>
            <button
              onClick={handleLogout}
              className="rounded px-3 py-2 text-left text-sm text-muted hover:text-foreground"
            >
              Sign out
            </button>
          </div>
        </aside>
        <div className="flex-1 p-8">{children}</div>
      </div>
    </CurrentUserProvider>
  );
}
