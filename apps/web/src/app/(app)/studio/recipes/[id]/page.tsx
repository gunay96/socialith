"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ASPECT_RATIOS, EDITORIAL_FORMATS, TEXT_POSITIONS } from "@socialith/publishing";
import { BACKGROUND_MODES, DURATION_MODES, ENTRY_ANIMATIONS, EXIT_ANIMATIONS, FIT_MODES, FONT_FAMILIES, IMAGE_FORMATS, TEXT_ALIGNS, TEXT_ANIMATIONS, type RecipeConfig } from "@socialith/studio";
import { ApiError, apiPatch, apiPost, apiPut, buildQueryString } from "@/lib/api";
import { IssueList, RecipePreview, SourceBadge, type Adjustment, type Evaluation, type RecipeDto } from "@/lib/recipes";
import { formatBytes, mediaUrl, useStudioRole, type AssetDto, type Paged } from "@/lib/studio";
import { ChipPicker, useAction, useNetworkOptions, type TextCategory, type TextDto } from "@/lib/texts";
import { Banner, Card, Chip, TONES, inputClass, useFetch } from "@/lib/upload-post";

// ------------------------------------------------------------------------------------------------ labels

const POSITION_LABEL: Record<string, string> = { TOP: "Top", UPPER_THIRD: "Upper third", CENTER: "Middle", LOWER_THIRD: "Lower third", BOTTOM: "Bottom" };
const LABELS = {
  fit: { COVER: "Fill the frame (crop)", CONTAIN: "Show everything (bars)" },
  weight: { REGULAR: "Regular", BOLD: "Bold" },
  transform: { NONE: "As written", UPPERCASE: "UPPERCASE" },
  align: { LEFT: "Left", CENTER: "Centre", RIGHT: "Right" },
  background: { NONE: "None", BOX: "Box around the text", BAND: "Band across the frame" },
  text: { NONE: "None", TYPEWRITER: "Typewriter", LINE_BY_LINE: "Line by line" },
  entry: { NONE: "None", FADE_IN: "Fade in", SLIDE_UP: "Slide up", ZOOM_IN: "Zoom in" },
  exit: { NONE: "None", FADE_OUT: "Fade out", SLIDE_DOWN: "Slide down" },
  duration: { SOURCE: "Follow the source", FIXED: "A fixed length" },
} as const;

// ------------------------------------------------------------------------------------------------ small form controls

type Sources = Evaluation["effective"]["sources"];

function Row({ label, source, children }: { label: string; source?: Sources[keyof Sources]; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>{label}</span>
        <SourceBadge source={source} />
      </div>
      {children}
    </div>
  );
}

function Pick<T extends string | number | boolean>({ label, value, effective, source, options, onChange, disabled }: { label: string; value: T | null; effective: T | undefined; source?: Sources[keyof Sources]; options: { value: T; label: string }[]; onChange: (v: T | null) => void; disabled?: boolean }) {
  const text = (v: T) => options.find((o) => o.value === v)?.label ?? String(v);
  return (
    <Row label={label} source={source}>
      <select
        value={value === null ? "" : String(value)}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.value === "" ? null : (options.find((o) => String(o.value) === e.target.value)?.value ?? null))}
        className={`${inputClass} py-1.5 text-sm`}
      >
        <option value="">Inherit{effective !== undefined ? `: ${text(effective)}` : ""}</option>
        {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </select>
    </Row>
  );
}

function Slider({ label, value, effective, source, min, max, step, unit, onChange, disabled }: { label: string; value: number | null; effective: number | undefined; source?: Sources[keyof Sources]; min: number; max: number; step: number; unit: string; onChange: (v: number | null) => void; disabled?: boolean }) {
  const shown = value ?? effective ?? min;
  return (
    <Row label={label} source={source}>
      <div className="flex items-center gap-2">
        <input type="range" aria-label={label} min={min} max={max} step={step} value={shown} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} className={`w-full accent-accent ${value === null ? "opacity-60" : ""}`} />
        <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted">{shown}{unit}</span>
        {value !== null && !disabled && <button type="button" onClick={() => onChange(null)} className="shrink-0 text-xs text-muted underline">Inherit</button>}
      </div>
    </Row>
  );
}

function ColorPick({ label, value, effective, source, onChange, disabled }: { label: string; value: string | null; effective: string | undefined; source?: Sources[keyof Sources]; onChange: (v: string | null) => void; disabled?: boolean }) {
  const shown = value ?? effective ?? "#ffffff";
  return (
    <Row label={label} source={source}>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={label} value={shown} disabled={disabled} onChange={(e) => onChange(e.target.value)} className="h-8 w-12 cursor-pointer rounded border border-border bg-surface p-0.5" />
        <code className="text-xs text-muted">{shown}</code>
        {value !== null && !disabled && <button type="button" onClick={() => onChange(null)} className="text-xs text-muted underline">Inherit</button>}
      </div>
    </Row>
  );
}

const opts = <T extends string>(list: readonly T[], labels: Record<string, string>): { value: T; label: string }[] => list.map((v) => ({ value: v, label: labels[v] ?? v }));

// ------------------------------------------------------------------------------------------------ the builder

interface Draft {
  name: string;
  description: string;
  formatId: string | null;
  requiredTextCategoryId: string | null;
  config: RecipeConfig;
  pageCategoryIds: string[];
  pageGroupIds: string[];
  pageIds: string[];
}

const toDraft = (r: RecipeDto): Draft => ({ name: r.name, description: r.description ?? "", formatId: r.formatId, requiredTextCategoryId: r.requiredTextCategory?.id ?? null, config: r.config, pageCategoryIds: r.assignments.pageCategories.map((x) => x.id), pageGroupIds: r.assignments.pageGroups.map((x) => x.id), pageIds: r.assignments.pages.map((x) => x.id) });

export default function RecipeBuilderPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const { isAdmin } = useStudioRole();
  const recipeQ = useFetch<RecipeDto>(`/api/recipes/${params.id}`);
  const recipe = recipeQ.data;
  const all = useFetch<{ items: RecipeDto[] }>("/api/recipes");
  const textCategories = useFetch<{ items: TextCategory[] }>("/api/text-library/categories");
  const network = useNetworkOptions();
  const { message, busy, run } = useAction();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [textId, setTextId] = useState<string | null>(null);
  const [pageId, setPageId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [adjSize, setAdjSize] = useState<number | null>(null);
  const [adjVertical, setAdjVertical] = useState<string | null>(null);
  const [adjOffset, setAdjOffset] = useState<number | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [replayKey, setReplayKey] = useState(0);
  const [mediaSearch, setMediaSearch] = useState("");
  const [textSearch, setTextSearch] = useState("");
  const [includeUnapproved, setIncludeUnapproved] = useState(false);
  const restored = useRef<string | null>(null);

  // load the recipe into the editable draft, and restore the last preview choices, once per loaded version
  useEffect(() => {
    if (!recipe) return;
    setDraft(toDraft(recipe));
    if (restored.current !== recipe.id) {
      restored.current = recipe.id;
      const p = recipe.previewConfig;
      setAssetId(p?.assetId ?? null);
      setTextId(p?.textId ?? null);
      setPageId(p?.pageId ?? "");
      setGroupId(p?.groupId ?? "");
      setAdjSize(p?.adjustment?.typography?.sizePct ?? null);
      setAdjVertical(p?.adjustment?.position?.vertical ?? null);
      setAdjOffset(p?.adjustment?.position?.offsetPct ?? null);
    }
  }, [recipe]);

  const adjustment = useMemo<Adjustment | undefined>(() => {
    const a: Adjustment = {};
    if (adjSize !== null) a.typography = { sizePct: adjSize };
    if (adjVertical !== null || adjOffset !== null) a.position = { ...(adjVertical !== null ? { vertical: adjVertical } : {}), ...(adjOffset !== null ? { offsetPct: adjOffset } : {}) };
    return a.typography || a.position ? a : undefined;
  }, [adjSize, adjVertical, adjOffset]);

  const evalBody = useMemo(() => {
    if (!draft) return null;
    return { recipeId: params.id, config: draft.config, formatId: draft.formatId, requiredTextCategoryId: draft.requiredTextCategoryId, pageCategoryIds: draft.pageCategoryIds, pageGroupIds: draft.pageGroupIds, pageIds: draft.pageIds, pageId: pageId || null, groupId: groupId || null, assetId, textId, adjustment, purpose: "PREVIEW" };
  }, [draft, params.id, pageId, groupId, assetId, textId, adjustment]);

  // the single calculation behind the preview: effective settings with their sources, layout and compatibility
  useEffect(() => {
    if (!evalBody) return;
    const timer = setTimeout(() => {
      apiPost<Evaluation>("/api/recipes/evaluate", evalBody)
        .then((e) => {
          setEvaluation(e);
          setEvalError(null);
        })
        .catch((err) => setEvalError(err instanceof ApiError ? err.message : "The preview could not be calculated."));
    }, 250);
    return () => clearTimeout(timer);
  }, [evalBody]);

  const assets = useFetch<Paged<AssetDto>>(`/api/media/assets${buildQueryString({ status: "READY", q: mediaSearch.trim() || undefined, sort: "newest", pageSize: 40 })}`);
  const texts = useFetch<Paged<TextDto>>(`/api/text-library/texts${buildQueryString({ status: includeUnapproved ? "ACTIVE" : "APPROVED", q: textSearch.trim() || undefined, forPageId: pageId || undefined, categoryId: draft?.requiredTextCategoryId || undefined, sort: "newest", pageSize: 40 })}`);

  const snapshot = useMemo(() => (recipe ? JSON.stringify(toDraft(recipe)) : ""), [recipe]);
  const dirty = draft !== null && JSON.stringify(draft) !== snapshot;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (recipeQ.loading && !recipe) return <p className="text-sm text-muted">Loading…</p>;
  if (recipeQ.error && !recipe) return <Banner tone="error">{recipeQ.error}</Banner>;
  if (!recipe || !draft) return null;

  const archived = recipe.status === "ARCHIVED";
  const editable = isAdmin && !archived;
  const v = evaluation?.effective.values;
  const src = evaluation?.effective.sources;
  const setCfg = (mutate: (c: RecipeConfig) => void) =>
    setDraft((d) => {
      if (!d) return d;
      const config = structuredClone(d.config);
      mutate(config);
      return { ...d, config };
    });
  const act = (okText: string, fn: () => Promise<unknown>) => run(okText, fn);
  const reload = () => recipeQ.reload();

  async function save() {
    if (!draft) return;
    const changedLists = JSON.stringify([draft.pageCategoryIds, draft.pageGroupIds, draft.pageIds]) !== JSON.stringify([recipe!.assignments.pageCategories.map((x) => x.id), recipe!.assignments.pageGroups.map((x) => x.id), recipe!.assignments.pages.map((x) => x.id)]);
    const r = await act("Recipe saved.", async () => {
      await apiPatch(`/api/recipes/${params.id}`, { name: draft.name.trim(), description: draft.description.trim() || null, formatId: draft.formatId, requiredTextCategoryId: draft.requiredTextCategoryId, config: draft.config });
      if (changedLists) await apiPut(`/api/recipes/${params.id}/assignments`, { pageCategoryIds: draft.pageCategoryIds, pageGroupIds: draft.pageGroupIds, pageIds: draft.pageIds });
      return true;
    });
    if (r) {
      restored.current = params.id; // keep the preview choices as they are
      reload();
      all.reload();
    }
  }

  const cfg = draft.config;
  const media = cfg.compatibleMedia;
  const shownAssets = (assets.data?.items ?? []).filter((a) => a.kind === "IMAGE" || a.kind === "VIDEO");
  const switchOptions = all.data?.items ?? [];
  const errorCount = evaluation?.issues.filter((i) => i.severity === "ERROR").length ?? 0;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/studio/recipes" className="text-sm text-muted hover:text-foreground">← Recipes</Link>
        <label className="flex items-center gap-2 text-xs text-muted">
          Switch recipe
          <select value={params.id} onChange={(e) => router.push(`/studio/recipes/${e.target.value}`)} className={`${inputClass} py-1 text-sm`}>
            {switchOptions.some((r) => r.id === params.id) ? null : <option value={params.id}>{recipe.name}</option>}
            {switchOptions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
      </div>

      {message && <Banner tone={message.tone}>{message.text}</Banner>}
      {recipe.configProblem && <Banner tone="warn">The stored settings of this recipe could not be read ({recipe.configProblem}), so it is shown with every setting inherited. Saving replaces them.</Banner>}
      {archived && <Banner tone="info">This recipe is archived. Restore it to edit it.</Banner>}
      {!isAdmin && <Banner tone="info">You can try this recipe in the preview. Administrators create and change recipes.</Banner>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="truncate text-lg font-semibold tracking-tight">{draft.name || "Untitled recipe"}</h2>
          {dirty && <Chip tone={TONES.AMBER}>unsaved changes</Chip>}
          {recipe.presetKey && <Chip>from a preset</Chip>}
          {recipe.duplicatedFrom && <span className="text-xs text-muted">copy of <Link href={`/studio/recipes/${recipe.duplicatedFrom.id}`} className="underline">{recipe.duplicatedFrom.name}</Link></span>}
        </div>
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button onClick={() => void save()} disabled={busy || !dirty || !editable || !draft.name.trim()} className="rounded bg-accent px-3 py-2 font-medium text-background disabled:opacity-40">Save recipe</button>
            {dirty && <button onClick={() => setDraft(toDraft(recipe))} disabled={busy} className="rounded border border-border px-3 py-2">Discard changes</button>}
            <button disabled={busy || dirty} title={dirty ? "Save or discard your changes first" : undefined} onClick={() => void act("Recipe duplicated.", () => apiPost<RecipeDto>(`/api/recipes/${params.id}/duplicate`, {}).then((c) => router.push(`/studio/recipes/${c.id}`)))} className="rounded border border-border px-3 py-2 disabled:opacity-40">Duplicate</button>
            {archived ? (
              <button disabled={busy} onClick={() => void act("Recipe restored.", () => apiPost(`/api/recipes/${params.id}/restore`, {}).then(reload))} className="rounded border border-border px-3 py-2">Restore</button>
            ) : (
              <button disabled={busy} onClick={() => void act("Recipe archived.", () => apiPost(`/api/recipes/${params.id}/archive`, {}).then(reload))} className="rounded border border-border px-3 py-2">Archive</button>
            )}
          </div>
        )}
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        {/* ---------------------------------------------------------------- preview (first on narrow screens) */}
        <div className="flex min-w-0 flex-col gap-4 xl:order-2 xl:sticky xl:top-4 xl:self-start">
          <Card title="Preview" action={<button onClick={() => setReplayKey((k) => k + 1)} className="rounded border border-border px-2.5 py-1 text-xs hover:border-foreground">Replay motion</button>}>
            {evalError && <Banner tone="error">{evalError}</Banner>}
            {evaluation ? <RecipePreview evaluation={evaluation} replayKey={replayKey} /> : <p className="text-sm text-muted">Calculating…</p>}
          </Card>

          <Card title="Try it with">
            <div className="flex flex-col gap-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  Page
                  <select value={pageId} onChange={(e) => { setPageId(e.target.value); if (!e.target.value) setGroupId(""); }} className={`${inputClass} py-1.5`}>
                    <option value="">No page</option>
                    {network.pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  Page group
                  <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className={`${inputClass} py-1.5`}>
                    <option value="">None</option>
                    {network.pageGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </label>
              </div>
              {evaluation?.target && <p className="-mt-2 text-xs text-muted">Settings left empty are taken from {evaluation.target.kind === "page" ? `the page "${evaluation.target.name}"${evaluation.target.groupName ? `, its group "${evaluation.target.groupName}"` : ""} and its category` : `the page group "${evaluation.target.name}"`}.</p>}

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span>Picture or video</span>
                  {assetId && <button onClick={() => setAssetId(null)} className="text-xs text-muted underline">Clear</button>}
                </div>
                <input type="search" value={mediaSearch} onChange={(e) => setMediaSearch(e.target.value)} placeholder="Search the Media Library" aria-label="Search the Media Library" className={`${inputClass} mb-2 w-full py-1.5`} />
                {shownAssets.length === 0 && <p className="text-xs text-muted">{assets.loading ? "Loading…" : <>No ready pictures or videos found. <Link href="/studio/upload" className="underline">Upload media</Link>.</>}</p>}
                <ul className="flex gap-2 overflow-x-auto pb-1" aria-label="Media Library files">
                  {shownAssets.map((a) => {
                    const accepted = media.includes(a.kind as "IMAGE" | "VIDEO");
                    return (
                      <li key={a.id} className="shrink-0">
                        <button type="button" onClick={() => setAssetId(a.id)} aria-pressed={assetId === a.id} title={`${a.originalName}${accepted ? "" : " (this recipe does not accept it)"}`} className={`flex h-20 w-16 flex-col overflow-hidden rounded border text-left ${assetId === a.id ? "border-accent" : "border-border"} ${accepted ? "" : "opacity-40"}`}>
                          {a.thumbnailUrl ? <img src={mediaUrl(a.thumbnailUrl)} alt="" loading="lazy" className="h-14 w-full object-cover" /> : <span className="flex h-14 w-full items-center justify-center bg-background text-[10px] uppercase text-muted">{a.kind === "VIDEO" ? "video" : "image"}</span>}
                          <span className="truncate px-1 py-0.5 text-[10px]">{a.originalName}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {evaluation?.asset && <p className="mt-1 truncate text-xs text-muted">{evaluation.asset.originalName} · {evaluation.asset.facts.width && evaluation.asset.facts.height ? `${evaluation.asset.facts.width} × ${evaluation.asset.facts.height} · ` : ""}{formatBytes(evaluation.asset.sizeBytes)}</p>}
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span>Text</span>
                  {textId && <button onClick={() => setTextId(null)} className="text-xs text-muted underline">Clear</button>}
                </div>
                <input type="search" value={textSearch} onChange={(e) => setTextSearch(e.target.value)} placeholder="Search the Text Library" aria-label="Search the Text Library" className={`${inputClass} mb-2 w-full py-1.5`} />
                <label className="mb-2 flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={includeUnapproved} onChange={(e) => setIncludeUnapproved(e.target.checked)} /> Also show texts that are not approved (to try a layout only)</label>
                <select value={textId ?? ""} onChange={(e) => setTextId(e.target.value || null)} aria-label="Text" className={`${inputClass} w-full py-1.5`}>
                  <option value="">Placeholder text</option>
                  {evaluation?.text && !(texts.data?.items ?? []).some((t) => t.id === evaluation.text!.id) && <option value={evaluation.text.id}>{evaluation.text.text.slice(0, 70)}</option>}
                  {(texts.data?.items ?? []).map((t) => <option key={t.id} value={t.id}>{t.text.replace(/\s+/g, " ").slice(0, 70)}{t.approval.status !== "APPROVED" ? ` (${t.approval.status.toLowerCase()})` : ""}</option>)}
                </select>
                <p className="mt-1 text-xs text-muted">{pageId ? "Showing texts that may be used for this page." : "Choose a page to see only the texts that suit it."}{draft.requiredTextCategoryId ? " Limited to the recipe's text category." : ""}</p>
              </div>

              <div className="rounded border border-border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span>Quick adjust <span className="text-xs text-muted">preview only</span></span>
                  {adjustment && (
                    <span className="flex gap-3 text-xs">
                      {editable && (
                        <button
                          onClick={() => {
                            setCfg((c) => {
                              if (adjSize !== null) c.typography.sizePct = adjSize;
                              if (adjVertical !== null) c.position.vertical = adjVertical as RecipeConfig["position"]["vertical"];
                              if (adjOffset !== null) c.position.offsetPct = adjOffset;
                            });
                            setAdjSize(null);
                            setAdjVertical(null);
                            setAdjOffset(null);
                          }}
                          className="underline"
                        >
                          Apply to the recipe
                        </button>
                      )}
                      <button onClick={() => { setAdjSize(null); setAdjVertical(null); setAdjOffset(null); }} className="text-muted underline">Reset</button>
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-3">
                  <Slider label="Font size" value={adjSize} effective={v?.sizePct} source={src?.sizePct} min={2} max={14} step={0.5} unit="%" onChange={setAdjSize} />
                  <Pick label="Text position" value={adjVertical} effective={v?.vertical} source={src?.vertical} options={TEXT_POSITIONS.map((p) => ({ value: p as string, label: POSITION_LABEL[p]! }))} onChange={setAdjVertical} />
                  <Slider label="Nudge up or down" value={adjOffset} effective={v?.offsetPct} source={src?.offsetPct} min={-25} max={25} step={1} unit="%" onChange={setAdjOffset} />
                </div>
                <p className="mt-2 text-xs text-muted">Changes here show in the preview and are not saved. Use "Apply to the recipe" to keep them.</p>
              </div>
              {isAdmin && (
                <button disabled={busy} onClick={() => void act("Preview choices saved.", () => apiPut(`/api/recipes/${params.id}/preview-config`, { assetId, textId, pageId: pageId || null, groupId: groupId || null, ...(adjustment ? { adjustment } : {}) }).then(reload))} className="self-start rounded border border-border px-3 py-1.5 text-xs hover:border-foreground disabled:opacity-40">Remember these preview choices</button>
              )}
            </div>
          </Card>

          <Card title={`Checks${evaluation ? ` (${evaluation.issues.length})` : ""}`}>
            {evaluation ? <IssueList issues={evaluation.issues} /> : <p className="text-sm text-muted">Calculating…</p>}
            {evaluation && evaluation.effective.warnings.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1 text-sm text-amber-400">{evaluation.effective.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            )}
            {errorCount > 0 && <p className="mt-3 text-xs text-muted">The items marked "must fix" would stop this combination from being rendered or published.</p>}
          </Card>
        </div>

        {/* ---------------------------------------------------------------- settings */}
        <div className="flex min-w-0 flex-col gap-4 xl:order-1">
          <Card title="Basics">
            <div className="flex flex-col gap-3 text-sm">
              <label className="flex flex-col gap-1">Name<input value={draft.name} disabled={!editable} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputClass} /></label>
              <label className="flex flex-col gap-1">Description<textarea value={draft.description} disabled={!editable} rows={2} maxLength={2000} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={inputClass} /></label>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="flex flex-col gap-1">
                  Format
                  <select value={draft.formatId ?? ""} disabled={!editable} onChange={(e) => setDraft({ ...draft, formatId: e.target.value || null })} className={inputClass}>
                    <option value="">None</option>
                    {EDITORIAL_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  Texts of category
                  <select value={draft.requiredTextCategoryId ?? ""} disabled={!editable} onChange={(e) => setDraft({ ...draft, requiredTextCategoryId: e.target.value || null })} className={inputClass}>
                    <option value="">Any category</option>
                    {textCategories.data?.items.filter((c) => c.status === "ACTIVE" || c.id === draft.requiredTextCategoryId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
              </div>
              <fieldset disabled={!editable}>
                <legend className="mb-1 text-xs text-muted">Works with</legend>
                <div className="flex gap-4">
                  {(["IMAGE", "VIDEO"] as const).map((k) => (
                    <label key={k} className="flex items-center gap-2">
                      <input type="checkbox" checked={media.includes(k)} onChange={() => setCfg((c) => { const next = c.compatibleMedia.includes(k) ? c.compatibleMedia.filter((m) => m !== k) : [...c.compatibleMedia, k]; if (next.length > 0) c.compatibleMedia = next; })} />
                      {k === "IMAGE" ? "Images" : "Videos"}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          </Card>

          <Card title="Where it is used">
            <p className="mb-3 text-xs text-muted">{draft.pageCategoryIds.length + draft.pageGroupIds.length + draft.pageIds.length === 0 ? "Not limited: this recipe is offered for every page." : "Offered for the pages, page groups and page categories chosen here. When several recipes fit a page, its own come first, then its group's, then its category's."}</p>
            <div className="flex flex-col gap-3">
              <ChipPicker label="Page categories" options={network.pageCategories} selected={draft.pageCategoryIds} onChange={(ids) => setDraft({ ...draft, pageCategoryIds: ids })} disabled={!editable} />
              <ChipPicker label="Page groups" options={network.pageGroups} selected={draft.pageGroupIds} onChange={(ids) => setDraft({ ...draft, pageGroupIds: ids })} disabled={!editable} />
              <ChipPicker label="Pages" options={network.pages} selected={draft.pageIds} onChange={(ids) => setDraft({ ...draft, pageIds: ids })} disabled={!editable} />
            </div>
          </Card>

          <Card title="Frame and export">
            <div className="grid gap-3 md:grid-cols-2">
              <Pick label="Aspect ratio" value={cfg.aspectRatio} effective={v?.aspectRatio} source={src?.aspectRatio} options={ASPECT_RATIOS.map((a) => ({ value: a as string, label: a }))} onChange={(x) => setCfg((c) => { c.aspectRatio = x as RecipeConfig["aspectRatio"]; })} disabled={!editable} />
              <Pick label="Picture in the frame" value={cfg.fit} effective={v?.fit} source={src?.fit} options={opts(FIT_MODES, LABELS.fit)} onChange={(x) => setCfg((c) => { c.fit = x; })} disabled={!editable} />
              <Pick label="Export size" value={cfg.export.resolution} effective={v?.exportResolution} source={src?.exportResolution} options={[{ value: "720", label: "720 (smaller file)" }, { value: "1080", label: "1080 (full HD)" }]} onChange={(x) => setCfg((c) => { c.export.resolution = x; })} disabled={!editable} />
              <Pick label="Frames per second (video)" value={cfg.export.fps} effective={v?.exportFps} source={src?.exportFps} options={[{ value: 24, label: "24" }, { value: 25, label: "25" }, { value: 30, label: "30" }]} onChange={(x) => setCfg((c) => { c.export.fps = x; })} disabled={!editable} />
              <Pick label="Still image format" value={cfg.export.imageFormat} effective={v?.imageFormat} source={src?.imageFormat} options={opts(IMAGE_FORMATS, { JPEG: "JPEG (smaller)", PNG: "PNG (lossless)" })} onChange={(x) => setCfg((c) => { c.export.imageFormat = x; })} disabled={!editable} />
            </div>
          </Card>

          <Card title="Text">
            <div className="grid gap-3 md:grid-cols-2">
              <Pick label="Font" value={cfg.typography.font} effective={v?.font} source={src?.font} options={FONT_FAMILIES.map((f) => ({ value: f.id, label: f.label }))} onChange={(x) => setCfg((c) => { c.typography.font = x; })} disabled={!editable} />
              <Pick label="Weight" value={cfg.typography.weight} effective={v?.weight} source={src?.weight} options={opts(["REGULAR", "BOLD"] as const, LABELS.weight)} onChange={(x) => setCfg((c) => { c.typography.weight = x; })} disabled={!editable} />
              <Slider label="Font size" value={cfg.typography.sizePct} effective={v?.sizePct} source={src?.sizePct} min={2} max={14} step={0.5} unit="%" onChange={(x) => setCfg((c) => { c.typography.sizePct = x; })} disabled={!editable} />
              <ColorPick label="Text color" value={cfg.typography.color} effective={v?.color} source={src?.color} onChange={(x) => setCfg((c) => { c.typography.color = x; })} disabled={!editable} />
              <Pick label="Letters" value={cfg.typography.transform} effective={v?.transform} source={src?.transform} options={opts(["NONE", "UPPERCASE"] as const, LABELS.transform)} onChange={(x) => setCfg((c) => { c.typography.transform = x; })} disabled={!editable} />
              <Pick label="Shadow behind the letters" value={cfg.typography.shadow} effective={v?.shadow} source={src?.shadow} options={[{ value: true, label: "On" }, { value: false, label: "Off" }]} onChange={(x) => setCfg((c) => { c.typography.shadow = x; })} disabled={!editable} />
            </div>
            <p className="mt-3 text-xs text-muted">The preview uses your browser's copy of the font; the renderer uses its own font files (DejaVu and Liberation), which cover Turkish letters.</p>
          </Card>

          <Card title="Position">
            <div className="grid gap-3 md:grid-cols-2">
              <Pick label="Vertical position" value={cfg.position.vertical} effective={v?.vertical} source={src?.vertical} options={TEXT_POSITIONS.map((p) => ({ value: p as string, label: POSITION_LABEL[p]! }))} onChange={(x) => setCfg((c) => { c.position.vertical = x as RecipeConfig["position"]["vertical"]; })} disabled={!editable} />
              <Pick label="Alignment" value={cfg.position.align} effective={v?.align} source={src?.align} options={opts(TEXT_ALIGNS, LABELS.align)} onChange={(x) => setCfg((c) => { c.position.align = x; })} disabled={!editable} />
              <Slider label="Nudge up or down" value={cfg.position.offsetPct} effective={v?.offsetPct} source={src?.offsetPct} min={-25} max={25} step={1} unit="%" onChange={(x) => setCfg((c) => { c.position.offsetPct = x; })} disabled={!editable} />
              <Slider label="Width of the text block" value={cfg.position.maxWidthPct} effective={v?.maxWidthPct} source={src?.maxWidthPct} min={40} max={100} step={1} unit="%" onChange={(x) => setCfg((c) => { c.position.maxWidthPct = x; })} disabled={!editable} />
            </div>
          </Card>

          <Card title="Text background">
            <div className="grid gap-3 md:grid-cols-2">
              <Pick label="Background" value={cfg.background.mode} effective={v?.backgroundMode} source={src?.backgroundMode} options={opts(BACKGROUND_MODES, LABELS.background)} onChange={(x) => setCfg((c) => { c.background.mode = x; })} disabled={!editable} />
              <ColorPick label="Background color" value={cfg.background.color} effective={v?.backgroundColor} source={src?.backgroundColor} onChange={(x) => setCfg((c) => { c.background.color = x; })} disabled={!editable} />
              <Slider label="Opacity" value={cfg.background.opacityPct} effective={v?.backgroundOpacityPct} source={src?.backgroundOpacityPct} min={0} max={100} step={1} unit="%" onChange={(x) => setCfg((c) => { c.background.opacityPct = x; })} disabled={!editable} />
              <Slider label="Padding" value={cfg.background.paddingPct} effective={v?.backgroundPaddingPct} source={src?.backgroundPaddingPct} min={0} max={8} step={0.5} unit="%" onChange={(x) => setCfg((c) => { c.background.paddingPct = x; })} disabled={!editable} />
            </div>
          </Card>

          <Card title="Motion and length">
            <div className="grid gap-3 md:grid-cols-2">
              <Pick label="Text animation" value={cfg.animation.text} effective={v?.textAnimation} source={src?.textAnimation} options={opts(TEXT_ANIMATIONS, LABELS.text)} onChange={(x) => setCfg((c) => { c.animation.text = x; })} disabled={!editable} />
              <Pick label="Entry" value={cfg.animation.entry} effective={v?.entryAnimation} source={src?.entryAnimation} options={opts(ENTRY_ANIMATIONS, LABELS.entry)} onChange={(x) => setCfg((c) => { c.animation.entry = x; })} disabled={!editable} />
              <Pick label="Exit" value={cfg.animation.exit} effective={v?.exitAnimation} source={src?.exitAnimation} options={opts(EXIT_ANIMATIONS, LABELS.exit)} onChange={(x) => setCfg((c) => { c.animation.exit = x; })} disabled={!editable} />
              <Slider label="Entry speed" value={cfg.animation.entryMs} effective={v?.entryMs} source={src?.entryMs} min={100} max={3000} step={100} unit=" ms" onChange={(x) => setCfg((c) => { c.animation.entryMs = x; })} disabled={!editable} />
              <Slider label="Exit speed" value={cfg.animation.exitMs} effective={v?.exitMs} source={src?.exitMs} min={100} max={3000} step={100} unit=" ms" onChange={(x) => setCfg((c) => { c.animation.exitMs = x; })} disabled={!editable} />
              <Pick label="Length" value={cfg.duration.mode} effective={v?.durationMode} source={src?.durationMode} options={opts(DURATION_MODES, LABELS.duration)} onChange={(x) => setCfg((c) => { c.duration.mode = x; })} disabled={!editable} />
              <Slider label="Fixed length" value={cfg.duration.seconds} effective={v?.durationSeconds} source={src?.durationSeconds} min={1} max={60} step={1} unit=" s" onChange={(x) => setCfg((c) => { c.duration.seconds = x; })} disabled={!editable} />
            </div>
            <p className="mt-3 text-xs text-muted">Motion needs a video: with a still picture, set a fixed length. "Fixed length" only applies when Length is "A fixed length".</p>
          </Card>

          <Card title="Subtitles">
            <div className="grid gap-3 md:grid-cols-2">
              <Pick label="Subtitles" value={cfg.subtitles.enabled} effective={v?.subtitlesEnabled} source={src?.subtitlesEnabled} options={[{ value: true, label: "On" }, { value: false, label: "Off" }]} onChange={(x) => setCfg((c) => { c.subtitles.enabled = x; })} disabled={!editable} />
              <Pick label="Subtitle position" value={cfg.subtitles.position} effective={v?.subtitlesPosition} source={src?.subtitlesPosition} options={TEXT_POSITIONS.map((p) => ({ value: p as string, label: POSITION_LABEL[p]! }))} onChange={(x) => setCfg((c) => { c.subtitles.position = x as RecipeConfig["subtitles"]["position"]; })} disabled={!editable} />
              <Slider label="Words per line" value={cfg.subtitles.wordsPerCue} effective={v?.subtitlesWordsPerCue} source={src?.subtitlesWordsPerCue} min={1} max={12} step={1} unit="" onChange={(x) => setCfg((c) => { c.subtitles.wordsPerCue = x; })} disabled={!editable} />
              <ColorPick label="Subtitle color" value={cfg.subtitles.color} effective={v?.subtitlesColor} source={src?.subtitlesColor} onChange={(x) => setCfg((c) => { c.subtitles.color = x; })} disabled={!editable} />
              <Pick label="Dark box behind subtitles" value={cfg.subtitles.background} effective={v?.subtitlesBackground} source={src?.subtitlesBackground} options={[{ value: true, label: "On" }, { value: false, label: "Off" }]} onChange={(x) => setCfg((c) => { c.subtitles.background = x; })} disabled={!editable} />
            </div>
            <p className="mt-3 text-xs text-muted">Subtitles split the chosen text into short lines shown one after another. They are generated from the text only; nothing is transcribed from the audio.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
