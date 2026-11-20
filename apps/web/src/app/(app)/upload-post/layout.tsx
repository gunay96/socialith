"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/upload-post", label: "Overview", exact: true },
  { href: "/upload-post/profiles", label: "Profiles" },
  { href: "/upload-post/accounts", label: "Accounts" },
  { href: "/upload-post/mapping", label: "Mapping" },
  { href: "/upload-post/history", label: "Publishing history" },
  { href: "/upload-post/scheduled", label: "Scheduled jobs" },
  { href: "/upload-post/health", label: "Provider health" },
  { href: "/upload-post/plan", label: "Plan & usage" },
];

export default function UploadPostLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-widest text-muted">Publishing provider</div>
      <h1 className="mb-4 text-xl font-semibold tracking-tight">Upload-Post</h1>
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
