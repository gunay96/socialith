"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/publishing", label: "Overview", exact: true },
  { href: "/publishing/calendar", label: "Publishing Calendar" },
  { href: "/publishing/queue", label: "Publishing Queue" },
  { href: "/publishing/publications", label: "All Publications" },
  { href: "/publishing/scheduled", label: "Scheduled Posts" },
  { href: "/publishing/failed", label: "Failed Publications" },
  { href: "/publishing/accounts", label: "Account Selection" },
  { href: "/publishing/approvals", label: "Approval Center" },
  { href: "/publishing/settings", label: "Publishing Settings" },
];

export default function PublishingLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div>
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-widest text-muted">Operations</div>
          <h1 className="mb-4 text-xl font-semibold tracking-tight">Publishing Center</h1>
        </div>
        <Link href="/publishing/new" className="rounded bg-accent px-3 py-2 text-sm font-medium text-background hover:opacity-90">
          New publication
        </Link>
      </div>
      <nav className="mb-6 flex flex-wrap gap-1 border-b border-border pb-2">
        {TABS.map((t) => {
          const active = t.exact ? pathname === t.href : pathname === t.href || pathname.startsWith(`${t.href}/`);
          return (
            <Link key={t.href} href={t.href} className={`rounded px-3 py-1.5 text-sm ${active ? "bg-accent/15 text-foreground" : "text-muted hover:text-foreground"}`}>
              {t.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
