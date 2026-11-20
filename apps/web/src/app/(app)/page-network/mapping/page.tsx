"use client";

import { useState } from "react";
import Link from "next/link";
import { ApiError, apiPut } from "@/lib/api";
import { MappingBadge, PlatformChip, useIsAdmin, type Mapping, type MappingState } from "@/lib/page-network";
import { PLATFORM_LABEL } from "@/lib/publishing";
import { Banner, Card, Chip, formatDateTime, inputClass, useFetch } from "@/lib/upload-post";

interface Row {
  page: { id: string; name: string; status: string; platform: string | null; username: string | null; category: { id: string; name: string } | null };
  mapping: Mapping;
}
interface Unlinked { id: string; platform: string; handle: string; displayName: string; status: string; provider: string; providerAccountStatus: string | null; profile: string | null }
interface MappingView { items: Row[]; counts: Record<MappingState, number>; unlinkedDestinations: Unlinked[] }

const STATES: MappingState[] = ["READY", "REAUTH_REQUIRED", "DISCONNECTED", "UNAVAILABLE", "NO_DESTINATION"];
const LABEL: Record<MappingState, string> = { READY: "Ready", REAUTH_REQUIRED: "Reconnect required", DISCONNECTED: "Disconnected", UNAVAILABLE: "Unavailable", NO_DESTINATION: "No account" };

export default function AccountMappingPage() {
  const isAdmin = useIsAdmin();
  const [state, setState] = useState<MappingState | "">("");
  const [pick, setPick] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const { data, error, loading, reload } = useFetch<MappingView>(`/api/page-network/mapping${state ? `?state=${state}` : ""}`);

  async function link(pageId: string, socialAccountId: string | null) {
    setMessage(null);
    try {
      await apiPut(`/api/page-network/pages/${pageId}/destination`, { socialAccountId });
      setMessage({ tone: "ok", text: socialAccountId ? "Account linked." : "Account unlinked." });
      setPick((p) => ({ ...p, [pageId]: "" }));
      reload();
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Could not change the link." });
    }
  }

  if (loading && !data) return <p className="text-sm text-muted">Loading…</p>;
  if (error || !data) return <Banner tone="error">{error ?? "Could not load the mapping."}</Banner>;

  return (
    <div className="flex flex-col gap-4">
      {message && <Banner tone={message.tone}>{message.text}</Banner>}
      <Banner tone="info">
        A page publishes only through the destination linked here. Destinations are created by connecting accounts in Upload-Post (then <Link href="/upload-post/accounts" className="underline">enabling them as destinations</Link>); this screen never creates or fakes an account, and the state below is read live from the provider synchronization.
      </Banner>

      <div className="flex flex-wrap gap-2">
        <button onClick={() => setState("")} className={`rounded border px-3 py-1.5 text-sm ${state === "" ? "border-accent bg-accent/10" : "border-border"}`}>All</button>
        {STATES.map((s) => (
          <button key={s} onClick={() => setState(s)} className={`rounded border px-3 py-1.5 text-sm ${state === s ? "border-accent bg-accent/10" : "border-border"}`}>
            {LABEL[s]} <span className="text-muted">{data.counts[s]}</span>
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded border border-border bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="px-4 py-2 font-normal">Page</th>
              <th className="px-4 py-2 font-normal">Account</th>
              <th className="px-4 py-2 font-normal">Provider / profile</th>
              <th className="px-4 py-2 font-normal">Authorization</th>
              <th className="px-4 py-2 font-normal">Last synchronized</th>
              {isAdmin && <th className="px-4 py-2 font-normal">Link</th>}
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 && <tr><td colSpan={isAdmin ? 6 : 5} className="px-4 py-6 text-center text-muted">No pages in this state.</td></tr>}
            {data.items.map(({ page, mapping: m }) => {
              const candidates = data.unlinkedDestinations.filter((d) => d.platform === page.platform);
              return (
                <tr key={page.id} className="border-b border-border align-top last:border-0">
                  <td className="px-4 py-2">
                    <Link href={`/page-network/pages/${page.id}`} className="font-medium hover:underline">{page.name}</Link>
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">{page.username ? `@${page.username}` : "no username"} <PlatformChip platform={page.platform} /></div>
                  </td>
                  <td className="px-4 py-2">
                    {m.destination ? <>@{m.destination.handle}<div className="text-xs text-muted">{PLATFORM_LABEL[m.destination.platform] ?? m.destination.platform} · {m.destination.status.toLowerCase()}</div></> : <span className="text-muted">—</span>}
                  </td>
                  <td className="px-4 py-2">
                    {m.destination ? <>{m.destination.provider === "UPLOAD_POST" ? "Upload-Post" : "Native"}<div className="text-xs text-muted">{m.upload?.profile?.username ?? (m.upload ? "profile hidden for your role" : "—")}</div>{m.publishing.capabilities.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{m.publishing.capabilities.map((c) => <Chip key={c}>{c}</Chip>)}</div>}</> : <span className="text-muted">—</span>}
                  </td>
                  <td className="px-4 py-2">
                    <MappingBadge state={m.state} label={m.stateLabel} />
                    {m.issues.length > 0 && <ul className="mt-1 max-w-xs list-disc pl-4 text-xs text-amber-400">{m.issues.map((i) => <li key={i.code}>{i.message}</li>)}</ul>}
                    {m.profileMappedToOtherPage && <div className="mt-1 text-xs text-muted">Profile is mapped to “{m.profileMappedToOtherPage.name}” (Phase 2).</div>}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap text-muted">{formatDateTime(m.lastSyncedAt)}</td>
                  {isAdmin && (
                    <td className="px-4 py-2">
                      {page.status === "ARCHIVED" ? <span className="text-xs text-muted">archived</span> : m.linked ? (
                        <button onClick={() => link(page.id, null)} className="rounded border border-border px-2 py-1 text-xs">Unlink</button>
                      ) : !page.platform ? (
                        <span className="text-xs text-muted">set the platform first</span>
                      ) : candidates.length === 0 ? (
                        <span className="text-xs text-muted">no free {PLATFORM_LABEL[page.platform] ?? page.platform} account</span>
                      ) : (
                        <div className="flex gap-1">
                          <select value={pick[page.id] ?? ""} onChange={(e) => setPick({ ...pick, [page.id]: e.target.value })} className={`${inputClass} py-1 text-xs`}>
                            <option value="">Choose…</option>
                            {candidates.map((d) => <option key={d.id} value={d.id}>@{d.handle}</option>)}
                          </select>
                          <button disabled={!pick[page.id]} onClick={() => link(page.id, pick[page.id]!)} className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40">Link</button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Card title={`Publishing accounts without a page (${data.unlinkedDestinations.length})`}>
        {data.unlinkedDestinations.length === 0 ? (
          <p className="text-sm text-muted">Every enabled publishing account already serves a page.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {data.unlinkedDestinations.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm first:pt-0 last:pb-0">
                <span>@{d.handle} <span className="text-xs text-muted">· {PLATFORM_LABEL[d.platform] ?? d.platform} · {d.provider === "UPLOAD_POST" ? "Upload-Post" : "Native"}</span></span>
                <span className="text-xs text-muted">{d.status.toLowerCase()}{d.providerAccountStatus ? ` · provider: ${d.providerAccountStatus.toLowerCase().replace(/_/g, " ")}` : ""}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted">Demo accounts and accounts assigned to an individual creator are never listed here.</p>
      </Card>
    </div>
  );
}
