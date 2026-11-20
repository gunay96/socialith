"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useIsAdmin } from "@/lib/page-network";

const TABS = [
  { href: "/page-network", label: "Overview", exact: true },
  { href: "/page-network/pages", label: "Managed Pages" },
  { href: "/page-network/categories", label: "Page Categories" },
  { href: "/page-network/groups", label: "Page Groups" },
  { href: "/page-network/mapping", label: "Account Mapping" },
];

export default function PageNetworkLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAdmin = useIsAdmin();
  return (
    <div>
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-widest text-muted">Operations</div>
          <h1 className="mb-4 text-xl font-semibold tracking-tight">Page Network</h1>
        </div>
        {isAdmin && (
          <Link href="/page-network/pages/new" className="rounded bg-accent px-3 py-2 text-sm font-medium text-background hover:opacity-90">
            New page
          </Link>
        )}
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
