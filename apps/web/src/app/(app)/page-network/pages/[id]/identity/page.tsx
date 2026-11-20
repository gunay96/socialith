"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, apiPost, apiPut } from "@/lib/api";
import {
  EMPTY_DRAFT,
  ProfileEditor,
  SourceTag,
  draftToProfile,
  hintClass,
  labelClass,
  profileToDraft,
  useIsAdmin,
  type EditorialProfile,
  type FormatDef,
  type Identity,
  type Issue,
  type PageItem,
} from "@/lib/page-network";
import { Banner, Card, Chip, TONES, inputClass, useFetch } from "@/lib/upload-post";

interface IdentityResponse {
  pageId: string;
  appliedGroup: { id: string; name: string } | null;
  category: { id: string; name: string; status: string } | null;
  own: { editorialIdentity: string | null; language: string | null; profile: EditorialProfile | null };
  effective: Identity;
}
interface CheckResult {
  ok: boolean;
  issues: Issue[];
  comparedWith: number;
  note: string | null;
}

const TONE: Record<string, string> = { ERROR: TONES.RED, WARNING: TONES.AMBER, INFO: TONES.BLUE };

export default function EditorialIdentityPage({ params }: { params: { id: string } }) {
  const isAdmin = useIsAdmin();
  const [groupId, setGroupId] = useState("");
  const page = useFetch<PageItem>(`/api/page-network/pages/${params.id}`);
  const identity = useFetch<IdentityResponse>(`/api/page-network/pages/${params.id}/identity${groupId ? `?groupId=${groupId}` : ""}`);
  const formats = useFetch<{ items: FormatDef[] }>("/api/page-network/formats");
  const [style, setStyle] = useState("");
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [check, setCheck] = useState<CheckResult | null>(null);

  // load the editable values once per page (switching the preview group must not discard unsaved edits)
  useEffect(() => {
    if (identity.data && loadedFor !== params.id) {
      setStyle(identity.data.own.editorialIdentity ?? "");
      setDraft(profileToDraft(identity.data.own.profile));
      setLoadedFor(params.id);
    }
  }, [identity.data, loadedFor, params.id]);

  async function save(reset: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      await apiPut(`/api/page-network/pages/${params.id}/identity`, reset ? { editorialIdentity: null, profile: null } : { editorialIdentity: style.trim() || null, profile: draftToProfile(draft) });
      if (reset) {
        setStyle("");
        setDraft(EMPTY_DRAFT);
      }
      setMessage({ tone: "ok", text: reset ? "Overrides removed: the page now inherits everything from its category." : "Editorial identity saved." });
      identity.reload();
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Could not save." });
    } finally {
      setBusy(false);
    }
  }

  async function runCheck() {
    setCheck(null);
    try {
      setCheck(await apiPost<CheckResult>(`/api/page-network/pages/${params.id}/check-text`, { text, ...(groupId ? { groupId } : {}) }));
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Could not check the text." });
    }
  }

  if (identity.loading && !identity.data) return <p className="text-sm text-muted">Loading…</p>;
  if (identity.error || !identity.data) return <Banner tone="error">{identity.error ?? "Could not load the identity."}</Banner>;
  const eff = identity.data.effective;
  const groups = (page.data?.groups ?? []);

  return (
    <div className="flex flex-col gap-4">
      <Link href={`/page-network/pages/${params.id}`} className="text-sm text-muted hover:text-foreground">← {page.data?.name ?? "Page"}</Link>
      {message && <Banner tone={message.tone}>{message.text}</Banner>}
      <Banner tone="info">
        Each page has its own editorial profile. Anything left blank here <strong>inherits</strong> the category{identity.data.category ? ` "${identity.data.category.name}"` : ""}; anything you fill in <strong>overrides</strong> it for this page only. No media is rendered and no text is placed automatically in this phase.
      </Banner>
      {!identity.data.category && <Banner tone="warn">This page has no category, so there is nothing to inherit. <Link href={`/page-network/pages/${params.id}`} className="underline">Choose a category</Link>.</Banner>}

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <Card title="This page's own settings">
          <div className="flex flex-col gap-5">
            <label className={labelClass}>
              <span className="flex items-center gap-2">Editorial identity <SourceTag source={eff.sources["editorialStyle"]} /></span>
              <textarea rows={3} maxLength={2000} disabled={!isAdmin} value={style} onChange={(e) => setStyle(e.target.value)} placeholder={eff.editorialStyle ?? "How this page speaks and what it posts"} className={inputClass} />
              <span className={hintClass}>For example: short motivational messages, cinematic backgrounds, bold typography.</span>
            </label>
            <ProfileEditor draft={draft} onChange={setDraft} formats={formats.data?.items ?? []} disabled={!isAdmin} inherited={eff} sources={eff.sources} />
            {isAdmin ? (
              <div className="flex flex-wrap gap-2">
                <button disabled={busy} onClick={() => save(false)} className="rounded bg-accent px-4 py-2 text-sm font-medium text-background disabled:opacity-40">{busy ? "Saving…" : "Save identity"}</button>
                <button disabled={busy} onClick={() => save(true)} className="rounded border border-border px-4 py-2 text-sm disabled:opacity-40">Remove all overrides</button>
              </div>
            ) : <p className="text-xs text-muted">Only administrators can change a page&apos;s editorial identity.</p>}
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card title="Effective identity">
            <div className="flex flex-col gap-3 text-sm">
              <label className={labelClass}>
                Preview with a group&apos;s preferences
                <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className={inputClass}>
                  <option value="">No group (page over category)</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <span className={hintClass}>Order: page, then group, then category.</span>
              </label>
              <dl className="grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1.5">
                <dt className="text-muted">Style</dt><dd>{eff.editorialStyle ?? "—"}</dd>
                <dt className="text-muted">Language</dt><dd>{eff.language ?? "—"}</dd>
                <dt className="text-muted">Formats</dt><dd>{eff.contentPreferences.formats.join(", ") || "—"}</dd>
                <dt className="text-muted">Visual</dt><dd>{eff.visual.style ?? "—"}</dd>
                <dt className="text-muted">Fonts</dt><dd>{eff.visual.fonts.join(", ") || "—"}</dd>
                <dt className="text-muted">Colors</dt>
                <dd className="flex flex-wrap items-center gap-1">{eff.visual.colors.length ? eff.visual.colors.map((c) => <span key={c} title={c} className="inline-block h-4 w-4 rounded border border-border" style={{ backgroundColor: /^#[0-9a-fA-F]{3,6}$/.test(c) ? c : "transparent" }} />) : "—"}</dd>
                <dt className="text-muted">Text position</dt><dd>{eff.visual.textPosition ?? "—"}</dd>
                <dt className="text-muted">Aspect ratio</dt><dd>{eff.visual.aspectRatio ?? "—"}</dd>
                <dt className="text-muted">Longest text</dt><dd>{eff.contentPreferences.maxTextLength ?? "no limit"}</dd>
                <dt className="text-muted">Rules</dt><dd>{eff.ruleEnforcement === "BLOCK" ? "block when broken" : "warn when broken"}</dd>
              </dl>
              {eff.guidelines && <p className="rounded border border-border p-2 text-xs text-muted">{eff.guidelines}</p>}
              {identity.data.appliedGroup && <p className="text-xs text-muted">Group applied: {identity.data.appliedGroup.name}</p>}
            </div>
          </Card>

          <Card title="Check a text against this page">
            <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste a caption or on-image text…" className={`${inputClass} w-full text-sm`} />
            <button disabled={!text.trim()} onClick={runCheck} className="mt-2 rounded border border-border px-3 py-1.5 text-sm disabled:opacity-40">Check text</button>
            {check && (
              <div className="mt-3 text-sm">
                {check.issues.length === 0 ? <p className="text-green-400">Nothing to flag against this page&apos;s rules.</p> : (
                  <ul className="flex flex-col gap-2">
                    {check.issues.map((i) => (
                      <li key={i.code} className="flex items-start gap-2"><Chip tone={TONE[i.severity]}>{i.severity.toLowerCase()}</Chip><span className="text-xs">{i.message}</span></li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-xs text-muted">{check.note ?? `Compared with the page's last ${check.comparedWith} post${check.comparedWith === 1 ? "" : "s"}.`} Advisory only: nothing is saved or published.</p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
