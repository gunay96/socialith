"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ApiError, apiPost, buildQueryString } from "@/lib/api";
import { IssueList, RecipePreview, type Issue, type RecipeDto } from "@/lib/recipes";
import { MATCH_WORDS, kindWord, type DuplicateDetails, type NotRenderableDetails, type RenderDetail, type RenderResolved } from "@/lib/renders";
import { formatBytes, formatDurationMs, mediaUrl, useStudioRole, type AssetDto, type Paged } from "@/lib/studio";
import { useNetworkOptions, type TextDto } from "@/lib/texts";
import { Banner, Card, Chip, TONES, inputClass, useFetch } from "@/lib/upload-post";

const asDetails = <T,>(err: unknown, code: string): T | null => {
  if (!(err instanceof ApiError)) return null;
  const d = err.details as { code?: string } | undefined;
  return d && d.code === code ? (d as unknown as T) : null;
};

export default function NewRenderPage() {
  const router = useRouter();
  const { canEdit } = useStudioRole();
  const network = useNetworkOptions();

  const [assetId, setAssetId] = useState<string | null>(null);
  const [textId, setTextId] = useState<string | null>(null);
  const [pageId, setPageId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [recipeId, setRecipeId] = useState<string | null>(null);
  const [mediaSearch, setMediaSearch] = useState("");
  const [textSearch, setTextSearch] = useState("");
  const [resolved, setResolved] = useState<RenderResolved | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitIssues, setSubmitIssues] = useState<Issue[]>([]);
  const [duplicate, setDuplicate] = useState<DuplicateDetails | null>(null);

  // links from other screens can pre-select the file, text and page: ?assetId=...&textId=...&pageId=...
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("assetId")) setAssetId(q.get("assetId"));
    if (q.get("textId")) setTextId(q.get("textId"));
    if (q.get("pageId")) setPageId(q.get("pageId") ?? "");
    if (q.get("groupId")) setGroupId(q.get("groupId") ?? "");
  }, []);

  const assets = useFetch<Paged<AssetDto>>(`/api/media/assets${buildQueryString({ status: "READY", q: mediaSearch.trim() || undefined, sort: "newest", pageSize: 40 })}`);
  const texts = useFetch<Paged<TextDto>>(`/api/text-library/texts${buildQueryString({ status: "APPROVED", q: textSearch.trim() || undefined, forPageId: pageId || undefined, sort: "newest", pageSize: 40 })}`);
  const recipes = useFetch<{ items: RecipeDto[] }>("/api/recipes");
  const renderable = (assets.data?.items ?? []).filter((a) => a.kind === "VIDEO" || a.kind === "IMAGE");

  // the checks and the plan, from the server's own calculation (the renderer follows exactly this plan)
  const body = useMemo(() => (assetId && textId ? { assetId, textId, ...(recipeId ? { recipeId } : {}), ...(pageId ? { pageId } : {}), ...(!pageId && groupId ? { groupId } : {}) } : null), [assetId, textId, recipeId, pageId, groupId]);
  useEffect(() => {
    setDuplicate(null);
    setSubmitError(null);
    setSubmitIssues([]);
    if (!body) {
      setResolved(null);
      return;
    }
    let cancelled = false;
    setResolving(true);
    const timer = setTimeout(() => {
      apiPost<RenderResolved>("/api/renders/resolve", body)
        .then((r) => {
          if (cancelled) return;
          setResolved(r);
          setResolveError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setResolved(null);
          setResolveError(err instanceof ApiError ? err.message : "The checks could not be calculated.");
        })
        .finally(() => {
          if (!cancelled) setResolving(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [body]);

  const evaluation = resolved?.evaluation ?? null;
  const chosen = resolved?.chosen ?? null;
  const errors = evaluation?.issues.filter((i) => i.severity === "ERROR") ?? [];
  const canStart = canEdit && Boolean(assetId && textId && chosen && evaluation && errors.length === 0 && !resolving && !submitting);

  const start = async (force: boolean) => {
    if (!assetId || !textId || !chosen) return;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitIssues([]);
    setDuplicate(null);
    try {
      // the recipe that was previewed is the recipe that is rendered: its id is sent explicitly
      const job = await apiPost<RenderDetail>("/api/renders", { assetId, textId, recipeId: chosen.id, ...(pageId ? { pageId } : {}), ...(!pageId && groupId ? { groupId } : {}), ...(campaignId ? { campaignId } : {}), ...(force ? { force: true } : {}) });
      router.push(`/studio/renders/${job.id}`);
    } catch (err) {
      const dup = asDetails<DuplicateDetails>(err, "DUPLICATE_RENDER");
      const nr = asDetails<NotRenderableDetails>(err, "NOT_RENDERABLE");
      if (dup) setDuplicate(dup);
      else if (nr) setSubmitIssues(nr.issues);
      setSubmitError(err instanceof ApiError ? err.message : "The render could not be started.");
      setSubmitting(false);
    }
  };

  if (!canEdit) return <Banner tone="warn">Viewers can look at renders but not start them. Ask an editor or an administrator.</Banner>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Link href="/studio/renders" className="text-muted hover:text-foreground">&larr; Rendering Studio</Link>
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card title="1. Picture or video">
            <input type="search" value={mediaSearch} onChange={(e) => setMediaSearch(e.target.value)} placeholder="Search the Media Library" aria-label="Search the Media Library" className={`${inputClass} mb-2 w-full py-1.5`} />
            {renderable.length === 0 && <p className="text-sm text-muted">{assets.loading ? "Loading…" : <>No ready pictures or videos found. <Link href="/studio/upload" className="underline">Upload media</Link>.</>}</p>}
            <ul className="flex gap-2 overflow-x-auto pb-1" aria-label="Media Library files">
              {renderable.map((a) => (
                <li key={a.id} className="shrink-0">
                  <button type="button" onClick={() => { setAssetId(a.id); setRecipeId(null); }} aria-pressed={assetId === a.id} title={a.originalName} className={`flex h-24 w-20 flex-col overflow-hidden rounded border text-left ${assetId === a.id ? "border-accent" : "border-border"}`}>
                    {a.thumbnailUrl ? <img src={mediaUrl(a.thumbnailUrl)} alt="" loading="lazy" className="h-16 w-full object-cover" /> : <span className="flex h-16 w-full items-center justify-center bg-background text-[10px] uppercase text-muted">{a.kind === "VIDEO" ? "video" : "image"}</span>}
                    <span className="truncate px-1 pt-0.5 text-[10px]">{a.originalName}</span>
                    <span className="truncate px-1 text-[10px] text-muted">{a.kind === "VIDEO" ? `video ${formatDurationMs(a.facts.durationMs)}` : "image"}</span>
                  </button>
                </li>
              ))}
            </ul>
            {assetId && (() => {
              const a = renderable.find((x) => x.id === assetId) ?? evaluation?.asset;
              return a ? <p className="mt-1 truncate text-xs text-muted">{a.originalName} · {a.facts.width && a.facts.height ? `${a.facts.width} × ${a.facts.height} · ` : ""}{formatBytes(a.sizeBytes)} · the original is not changed</p> : null;
            })()}
          </Card>

          <Card title="2. For which page">
            <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                Page
                <select value={pageId} onChange={(e) => { setPageId(e.target.value); setRecipeId(null); }} className={`${inputClass} py-1.5`}>
                  <option value="">No single page</option>
                  {network.pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Page group {pageId ? <span className="text-xs text-muted">(only used when no page is chosen)</span> : null}
                <select value={groupId} disabled={Boolean(pageId)} onChange={(e) => { setGroupId(e.target.value); setRecipeId(null); }} className={`${inputClass} py-1.5 disabled:opacity-50`}>
                  <option value="">None</option>
                  {network.pageGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 sm:col-span-2">
                Campaign <span className="text-xs text-muted">(optional: the result is filed under it in the Media Library)</span>
                <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} className={`${inputClass} py-1.5`}>
                  <option value="">No campaign</option>
                  {network.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            </div>
            <p className="mt-2 text-xs text-muted">The page decides which recipe is used (its own, then its group&rsquo;s, then its category&rsquo;s, then recipes for every page) and which of its own settings (language, text colour) apply.</p>
          </Card>

          <Card title="3. Approved text">
            <input type="search" value={textSearch} onChange={(e) => setTextSearch(e.target.value)} placeholder="Search the Text Library" aria-label="Search the Text Library" className={`${inputClass} mb-2 w-full py-1.5`} />
            {(texts.data?.items ?? []).length === 0 && <p className="text-sm text-muted">{texts.loading ? "Loading…" : <>No approved texts found{pageId ? " for this page" : ""}. <Link href="/studio/texts" className="underline">Open the Text Library</Link>.</>}</p>}
            <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto" aria-label="Approved texts">
              {(texts.data?.items ?? []).map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => setTextId(t.id)} aria-pressed={textId === t.id} className={`w-full rounded border px-2 py-1.5 text-left text-sm ${textId === t.id ? "border-accent bg-accent/10" : "border-border"}`}>
                    <span className="line-clamp-2">{t.text}</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-muted">Only approved texts can be rendered. The words are copied into the render when you start it, so later edits do not change it.</p>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-4 xl:self-start">
          <Card title="Check and preview">
            {!body && <p className="text-sm text-muted">Choose a picture or video and an approved text to see the recipe, the checks and a preview.</p>}
            {resolveError && <Banner tone="error">{resolveError}</Banner>}
            {body && resolving && !resolved && <p className="text-sm text-muted">Checking…</p>}
            {body && !pageId && !groupId && (
              <label className="mb-3 flex flex-col gap-1 text-sm">
                Recipe <span className="text-xs text-muted">No page or page group is chosen, so pick the recipe yourself (or choose a page and the right one is found for it).</span>
                <select value={recipeId ?? ""} onChange={(e) => setRecipeId(e.target.value || null)} className={`${inputClass} py-1.5`}>
                  <option value="">Choose a recipe</option>
                  {(recipes.data?.items ?? []).filter((r) => r.status === "ACTIVE").map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
            )}
            {resolved && !chosen && (pageId || groupId) && <Banner tone="warn">No recipe suits this page or group and this kind of media. Assign a recipe to the page, its group or its category in <Link href="/studio/recipes" className="underline">Recipes</Link>.</Banner>}

            {resolved && resolved.candidates.length > 0 && (
              <fieldset className="mb-3">
                <legend className="mb-1 text-xs text-muted">Recipe</legend>
                <div className="flex flex-col gap-1">
                  {resolved.candidates.map((c) => (
                    <label key={c.id} className={`flex cursor-pointer items-center justify-between gap-2 rounded border px-2 py-1.5 text-sm ${chosen?.id === c.id ? "border-accent bg-accent/10" : "border-border"}`}>
                      <span className="flex min-w-0 items-center gap-2"><input type="radio" name="recipe" checked={chosen?.id === c.id} onChange={() => setRecipeId(c.id)} /><span className="truncate">{c.name}</span></span>
                      <span className="shrink-0 text-[11px] text-muted">{MATCH_WORDS[c.matchedBy]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {evaluation && (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                  {evaluation.output && <Chip tone={TONES.BLUE}>{kindWord(evaluation.output.kind)}{evaluation.output.kind === "VIDEO" ? `, ${formatDurationMs(evaluation.output.durationMs)}` : ""}</Chip>}
                  <Chip>{evaluation.plan.frame.width} × {evaluation.plan.frame.height}</Chip>
                  <Chip>{evaluation.effective.values.aspectRatio}</Chip>
                </div>
                <RecipePreview evaluation={evaluation} replayKey={0} />
                <div className="mt-4">
                  <IssueList issues={evaluation.issues} />
                </div>
              </>
            )}
          </Card>

          {submitError && (
            <div role="alert" className="rounded border border-red-900 bg-red-950/40 p-3 text-sm">
              <p className="text-red-300">{submitError}</p>
              {submitIssues.length > 0 && <div className="mt-2"><IssueList issues={submitIssues} /></div>}
              {duplicate?.jobId && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Link href={`/studio/renders/${duplicate.jobId}`} className="rounded border border-border px-2.5 py-1 text-xs hover:border-foreground">Open the existing render</Link>
                  {duplicate.canForce && <button type="button" disabled={submitting} onClick={() => void start(true)} className="rounded border border-border px-2.5 py-1 text-xs hover:border-foreground disabled:opacity-40">Render again on purpose</button>}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" disabled={!canStart} onClick={() => void start(false)} className="rounded bg-accent px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-40">
              {submitting ? "Starting…" : "Start render"}
            </button>
            {errors.length > 0 && <span className="text-xs text-red-300">Fix the problems marked &ldquo;must fix&rdquo; first.</span>}
          </div>
          <p className="text-xs text-muted">The result is saved in the Media Library as a new file (the original stays as it is) and is not published anywhere automatically.</p>
        </div>
      </div>
    </div>
  );
}
