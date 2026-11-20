"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { COMMON_LANGUAGES, TEXT_MAX_LENGTH, textLength } from "@socialith/studio";
import { apiPatch, apiPost, apiPut } from "@/lib/api";
import { usePolling, useStudioRole } from "@/lib/studio";
import { ApprovalChip, ChipPicker, RightsChip, SOURCE_LABEL, languageLabel, useAction, useNetworkOptions, type TextCategory, type TextDetail } from "@/lib/texts";
import { Banner, Card, Chip, formatDateTime, inputClass, useFetch } from "@/lib/upload-post";

export default function TextDetailPage({ params }: { params: { id: string } }) {
  const { canEdit, isAdmin } = useStudioRole();
  const { data: t, error, loading, reload } = usePolling<TextDetail>(`/api/text-library/texts/${params.id}`, 30000);
  const categories = useFetch<{ items: TextCategory[] }>("/api/text-library/categories");
  const network = useNetworkOptions();
  const { message, busy, run } = useAction();

  const [body, setBody] = useState("");
  const [language, setLanguage] = useState("");
  const [author, setAuthor] = useState("");
  const [sourceNote, setSourceNote] = useState("");
  const [notes, setNotes] = useState("");
  const [rejectNote, setRejectNote] = useState("");
  const [rights, setRights] = useState<{ status: "UNVERIFIED" | "CONFIRMED" | "RESTRICTED"; notes: string }>({ status: "UNVERIFIED", notes: "" });
  const [usage, setUsage] = useState({ note: "", pageId: "", campaignId: "" });

  // re-sync the editable fields only when the saved values change (not on every refresh)
  const savedText = t?.text ?? "";
  const savedLanguage = t?.language ?? "";
  const savedAuthor = t?.author ?? "";
  const savedSource = t?.sourceNote ?? "";
  const savedNotes = t?.notes ?? "";
  const savedRightsStatus = t?.rights.status ?? "UNVERIFIED";
  const savedRightsNotes = t?.rights.notes ?? "";
  useEffect(() => {
    setBody(savedText);
    setLanguage(savedLanguage);
    setAuthor(savedAuthor);
    setSourceNote(savedSource);
    setNotes(savedNotes);
    setRights({ status: savedRightsStatus, notes: savedRightsNotes });
  }, [savedText, savedLanguage, savedAuthor, savedSource, savedNotes, savedRightsStatus, savedRightsNotes]);

  if (loading && !t) return <p className="text-sm text-muted">Loading…</p>;
  if (error && !t) return <Banner tone="error">{error}</Banner>;
  if (!t) return null;

  const status = t.approval.status;
  const archived = status === "ARCHIVED";
  const editable = canEdit && !archived;
  const length = textLength(body);
  const dirty = body !== t.text || language !== (t.language ?? "") || author !== (t.author ?? "") || sourceNote !== (t.sourceNote ?? "") || notes !== (t.notes ?? "");
  const act = (okText: string, fn: () => Promise<unknown>) => run(okText, fn).then((r) => { if (r !== undefined) reload(); });
  const setLinks = (path: string, key: string, ids: string[]) => act("Saved.", () => apiPut(`/api/text-library/texts/${t.id}/${path}`, { [key]: ids }));

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Link href="/studio/texts" className="text-sm text-muted hover:text-foreground">← Text Library</Link>
      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ApprovalChip status={status} />
          <RightsChip status={t.rights.status} />
          <Chip>{SOURCE_LABEL[t.source]}</Chip>
          <Chip>{languageLabel(t.language)}</Chip>
          <span className="text-xs text-muted">{t.charCount} characters · added {formatDateTime(t.createdAt)}</span>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {!archived && status !== "APPROVED" && <button disabled={busy} onClick={() => void act("Approved.", () => apiPost(`/api/text-library/texts/${t.id}/approve`, {}))} className="rounded bg-accent px-3 py-2 font-medium text-background disabled:opacity-40">Approve</button>}
            {!archived && (
              <>
                <input value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} placeholder="Reason for rejecting" aria-label="Reason for rejecting" className={`${inputClass} w-48 py-1.5`} />
                <button disabled={busy || !rejectNote.trim()} onClick={() => void act("Rejected.", () => apiPost(`/api/text-library/texts/${t.id}/reject`, { note: rejectNote.trim() }).then(() => setRejectNote("")))} className="rounded border border-border px-3 py-2 disabled:opacity-40">Reject</button>
              </>
            )}
            {archived ? (
              <button disabled={busy} onClick={() => void act("Restored.", () => apiPost(`/api/text-library/texts/${t.id}/restore`, {}))} className="rounded border border-border px-3 py-2">Restore</button>
            ) : (
              <button disabled={busy} onClick={() => void act("Archived.", () => apiPost(`/api/text-library/texts/${t.id}/archive`, {}))} className="rounded border border-border px-3 py-2">Archive</button>
            )}
          </div>
        )}
      </div>
      {t.approval.reviewNote && <Banner tone={status === "REJECTED" ? "error" : "info"}>Review note: {t.approval.reviewNote}</Banner>}
      {status === "PENDING" && !isAdmin && <Banner tone="info">An administrator has to approve this text before it can be used.</Banner>}
      {t.rights.status === "RESTRICTED" && <Banner tone="warn">This text is marked "do not use", so it cannot be approved or used.</Banner>}

      <Card title="The text">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act("Saved.", () => apiPatch(`/api/text-library/texts/${t.id}`, { text: body, language: language || null, author: author || null, sourceNote: sourceNote || null, notes: notes || null }));
          }}
          className="flex flex-col gap-3 text-sm"
        >
          <textarea value={body} onChange={(e) => setBody(e.target.value)} disabled={!editable} rows={5} aria-label="The text" className={`${inputClass} w-full`} />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className={length > TEXT_MAX_LENGTH ? "text-red-400" : "text-muted"}>{length} / {TEXT_MAX_LENGTH} characters</span>
            {status === "APPROVED" && body !== t.text && <span className="text-amber-400">Changing the words sends this text back for review.</span>}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="flex flex-col gap-1">
              Language
              <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={!editable} className={inputClass}>
                <option value="">Not set</option>
                {COMMON_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                {language && !COMMON_LANGUAGES.some((l) => l.code === language) && <option value={language}>{language}</option>}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              Author or speaker
              <input value={author} onChange={(e) => setAuthor(e.target.value)} disabled={!editable} maxLength={255} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1">
              Source
              <input value={sourceNote} onChange={(e) => setSourceNote(e.target.value)} disabled={!editable} maxLength={255} className={inputClass} />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            Notes
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!editable} rows={2} maxLength={4000} className={`${inputClass} w-full`} />
          </label>
          {editable && <button disabled={busy || !dirty || length === 0 || length > TEXT_MAX_LENGTH} className="self-start rounded border border-border px-3 py-1.5 disabled:opacity-40">Save changes</button>}
          {archived && <p className="text-xs text-muted">An archived text cannot be edited. Restore it first.</p>}
        </form>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Categories">
          <p className="mb-2 text-xs text-muted">A text can belong to several categories when you assign them.</p>
          <ChipPicker label="Text categories" options={categories.data?.items.filter((c) => c.status === "ACTIVE") ?? []} selected={t.categories.map((c) => c.id)} onChange={(ids) => void setLinks("categories", "categoryIds", ids)} disabled={!editable} empty="No categories yet." />
        </Card>

        <Card title="Where it can be used">
          <p className="mb-3 text-xs text-muted">{t.appliesToAllPages ? "Not limited: this text suits every page." : "Limited to the pages, page groups and page categories chosen below."} Campaigns only describe what the text was written for.</p>
          <div className="flex flex-col gap-3">
            <ChipPicker label="Page categories" options={network.pageCategories} selected={t.pageCategories.map((c) => c.id)} onChange={(ids) => void setLinks("page-categories", "pageCategoryIds", ids)} disabled={!editable} />
            <ChipPicker label="Page groups" options={network.pageGroups} selected={t.pageGroups.map((c) => c.id)} onChange={(ids) => void setLinks("page-groups", "pageGroupIds", ids)} disabled={!editable} />
            <ChipPicker label="Pages" options={network.pages} selected={t.pages.map((c) => c.id)} onChange={(ids) => void setLinks("pages", "pageIds", ids)} disabled={!editable} />
            <ChipPicker label="Campaigns" options={network.campaigns} selected={t.campaigns.map((c) => c.id)} onChange={(ids) => void setLinks("campaigns", "campaignIds", ids)} disabled={!editable} />
          </div>
        </Card>

        <Card title="Usage rights">
          <p className="mb-2 text-xs text-muted">Record whether the organization may use this text (it wrote it, has a licence, or it is public domain). Socialith does not check this for you.</p>
          <div className="flex flex-col gap-2 text-sm">
            <select value={rights.status} disabled={!isAdmin} onChange={(e) => setRights({ ...rights, status: e.target.value as typeof rights.status })} aria-label="Rights status" className={inputClass}>
              <option value="UNVERIFIED">Not verified</option>
              <option value="CONFIRMED">Confirmed: we may use it</option>
              <option value="RESTRICTED">Restricted: do not use</option>
            </select>
            <textarea value={rights.notes} disabled={!isAdmin} onChange={(e) => setRights({ ...rights, notes: e.target.value })} rows={2} maxLength={2000} placeholder="Who wrote it, licence, contract…" aria-label="Rights notes" className={inputClass} />
            {isAdmin ? <button disabled={busy} onClick={() => void act("Rights saved.", () => apiPut(`/api/text-library/texts/${t.id}/rights`, { status: rights.status, notes: rights.notes.trim() || null }))} className="self-start rounded border border-border px-3 py-1.5">Save rights</button> : <p className="text-xs text-muted">Only administrators can change this.</p>}
          </div>
        </Card>

        <Card title="Where it came from">
          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted">Source</dt>
            <dd>{SOURCE_LABEL[t.source]}{t.sourceRow ? `, row ${t.sourceRow}` : ""}</dd>
            {t.importBatch && (
              <>
                <dt className="text-muted">Import</dt>
                <dd><Link href={`/studio/texts?batchId=${t.importBatch.id}`} className="underline">{t.importBatch.fileName}</Link> <span className="text-xs text-muted">{formatDateTime(t.importBatch.createdAt)}</span></dd>
              </>
            )}
            <dt className="text-muted">Collections</dt>
            <dd>{t.collections.length ? t.collections.map((c) => <Link key={c.id} href={`/studio/texts?collectionId=${c.id}`} className="mr-2 underline">{c.name}</Link>) : <span className="text-muted">none</span>}</dd>
            <dt className="text-muted">Approved</dt>
            <dd>{t.approval.approvedAt ? formatDateTime(t.approval.approvedAt) : <span className="text-muted">not approved</span>}</dd>
          </dl>
        </Card>
      </div>

      <Card title={`Usage history (${t.usageCount})`}>
        {t.recentUsages.length === 0 && <p className="text-sm text-muted">This text has not been used yet.</p>}
        <ul className="divide-y divide-border">
          {t.recentUsages.map((u) => (
            <li key={u.id} className="py-2 text-sm first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <Chip>{u.kind === "MANUAL" ? "recorded" : u.kind === "PUBLICATION" ? "published" : "rendered"}</Chip>
                <span className="text-xs text-muted">{formatDateTime(u.usedAt)}</span>
                {u.page && <span>on {u.page.name}</span>}
                {u.campaign && <span className="text-muted">· {u.campaign.name}</span>}
                {u.recipe && <span className="text-muted">· recipe {u.recipe.name}</span>}
                {u.mediaAsset && <Link href={`/studio/assets/${u.mediaAsset.id}`} className="text-muted underline">· {u.mediaAsset.name}</Link>}
              </div>
              {u.note && <p className="mt-0.5 text-xs text-muted">{u.note}</p>}
            </li>
          ))}
        </ul>
        {editable && status === "APPROVED" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act("Use recorded.", () => apiPost(`/api/text-library/texts/${t.id}/usages`, { note: usage.note || null, pageId: usage.pageId || undefined, campaignId: usage.campaignId || undefined }).then(() => setUsage({ note: "", pageId: "", campaignId: "" })));
            }}
            className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-3 text-sm"
          >
            <label className="flex flex-col gap-1 text-xs text-muted">Page<select value={usage.pageId} onChange={(e) => setUsage({ ...usage, pageId: e.target.value })} className={`${inputClass} text-sm`}><option value="">Not specified</option>{network.pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="flex flex-col gap-1 text-xs text-muted">Campaign<select value={usage.campaignId} onChange={(e) => setUsage({ ...usage, campaignId: e.target.value })} className={`${inputClass} text-sm`}><option value="">Not specified</option>{network.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted">Note<input value={usage.note} onChange={(e) => setUsage({ ...usage, note: e.target.value })} maxLength={500} placeholder="where or how it was used" className={`${inputClass} text-sm`} /></label>
            <button disabled={busy} className="rounded border border-border px-3 py-2">Record a use</button>
          </form>
        )}
        <p className="mt-3 text-xs text-muted">Publishing and rendering add their own entries here automatically when those steps arrive; previews never count as a use.</p>
      </Card>
    </div>
  );
}
