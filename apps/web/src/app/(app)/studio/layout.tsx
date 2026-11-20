"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStudioRole } from "@/lib/studio";

const TABS = [
  { href: "/studio", label: "Media Library", exact: true },
  { href: "/studio/upload", label: "Upload" },
  { href: "/studio/queue", label: "Processing Queue" },
  { href: "/studio/texts", label: "Text Library" },
  { href: "/studio/recipes", label: "Recipes" },
];

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { canEdit } = useStudioRole();
  return (
    <div>
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-widest text-muted">Create</div>
          <h1 className="mb-4 text-xl font-semibold tracking-tight">Content Studio</h1>
        </div>
        {canEdit && (
          <Link href="/studio/upload" className="rounded bg-accent px-3 py-2 text-sm font-medium text-background hover:opacity-90">
            Upload media
          </Link>
        )}
      </div>
      <nav aria-label="Content Studio" className="mb-6 flex flex-wrap gap-1 border-b border-border pb-2">
        {TABS.map((t) => {
          const active = t.exact ? pathname === t.href || pathname.startsWith("/studio/assets") || pathname.startsWith("/studio/packs") : pathname === t.href || pathname.startsWith(`${t.href}/`);
          return (
            <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined} className={`rounded px-3 py-1.5 text-sm ${active ? "bg-accent/15 text-foreground" : "text-muted hover:text-foreground"}`}>
              {t.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
