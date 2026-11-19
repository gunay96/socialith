"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Tab shell for one connected account. Only "Overview" is real today —
 * Content/Publishing/Analytics are disabled placeholders for the phases
 * that attach to this account (docs/architecture.md's pipeline:
 * Connected Accounts → Content → Video Engine → Publishing → Analytics).
 * Structured as its own layout (not folded into page.tsx) so adding a
 * real `[id]/content/page.tsx` etc. later is a new file, not a rewrite
 * of this one.
 */
const TABS = [
  { href: "", label: "Overview" },
  { href: "/content", label: "Content" },
  { href: "/publishing", label: "Publishing" },
  { href: "/analytics", label: "Analytics" },
] as const;

export default function AccountDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { id: string };
}) {
  const pathname = usePathname();
  const base = `/accounts/${params.id}`;

  return (
    <div>
      <Link href="/accounts" className="mb-4 inline-block text-sm text-muted hover:text-foreground">
        ← All accounts
      </Link>
      <nav className="mb-6 flex gap-1 border-b border-border">
        {TABS.map((tab) => {
          const href = `${base}${tab.href}`;
          const isOverview = tab.href === "";
          const active = pathname === href;
          if (!isOverview) {
            return (
              <span
                key={tab.label}
                className="cursor-not-allowed px-3 py-2 text-sm text-border"
                title="Coming in a later phase"
              >
                {tab.label} <span className="text-xs">soon</span>
              </span>
            );
          }
          return (
            <Link
              key={tab.label}
              href={href}
              className={`border-b-2 px-3 py-2 text-sm ${
                active ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
