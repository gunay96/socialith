"use client";

import { useEffect, useRef, useState } from "react";
import { fontById, splitIntoCues, describeSource, type EffectiveValues, type RecipeConfig, type SettingSource, type TextLayout } from "@socialith/studio";
import { mediaUrl, type AssetDto } from "@/lib/studio";
import type { Named } from "@/lib/texts";
import { TONES } from "@/lib/upload-post";

// ------------------------------------------------------------------------------------------------ API shapes

export interface RecipeDto {
  id: string;
  name: string;
  description: string | null;
  status: "ACTIVE" | "ARCHIVED";
  formatId: string | null;
  format: { id: string; label: string; needsVerifiedFacts: boolean } | null;
  presetKey: string | null;
  config: RecipeConfig;
  configProblem: string | null;
  previewConfig: { assetId: string | null; textId: string | null; pageId: string | null; groupId: string | null; adjustment: Adjustment | null } | null;
  requiredTextCategory: Named | null;
  duplicatedFrom: Named | null;
  assignments: { pageCategories: Named[]; pageGroups: Named[]; pages: Named[]; appliesToAllPages: boolean };
  version: number;
  createdAt: string;
  updatedAt: string;
  matchedBy?: "page" | "group" | "category" | "everyone" | null;
}

export interface PresetDto {
  key: string;
  name: string;
  description: string;
  formatId: string | null;
  textCategorySlug: string | null;
  config: RecipeConfig;
  recipes: { id: string; name: string; status: string }[];
}

export interface Issue { code: string; severity: "ERROR" | "WARNING" | "INFO"; field: string; message: string }

export interface Evaluation {
  recipe: Named | null;
  target: { kind: "page" | "group"; id: string; name: string; groupName: string | null } | null;
  effective: { values: EffectiveValues; sources: Record<keyof EffectiveValues, SettingSource>; warnings: string[] };
  layout: TextLayout;
  issues: Issue[];
  blocking: boolean;
  asset: AssetDto | null;
  text: { id: string; text: string; approvalStatus: string; language: string | null } | null;
  preview: true;
}

/** The preview-only changes (a subset of the recipe's settings). */
export interface Adjustment {
  typography?: { sizePct?: number | null };
  position?: { vertical?: string | null; offsetPct?: number | null };
}

export const MATCH_LABEL: Record<NonNullable<RecipeDto["matchedBy"]>, string> = { page: "set for this page", group: "set for its page group", category: "set for its page category", everyone: "for every page" };

// ------------------------------------------------------------------------------------------------ small pieces

const SOURCE_TONE: Record<SettingSource, string> = {
  adjustment: TONES.AMBER,
  recipe: TONES.BLUE,
  page: TONES.GREEN,
  group: TONES.GREEN,
  category: TONES.GREEN,
  default: TONES.NEUTRAL,
};
const SOURCE_SHORT: Record<SettingSource, string> = { adjustment: "preview only", recipe: "recipe", page: "from page", group: "from group", category: "from category", default: "default" };

/** Says where an effective setting comes from, in words (never by color alone). */
export function SourceBadge({ source }: { source: SettingSource | undefined }) {
  if (!source) return null;
  return (
    <span title={describeSource(source)} className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap ${SOURCE_TONE[source]}`}>
      {SOURCE_SHORT[source]}
    </span>
  );
}

export function IssueList({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) return <p className="text-sm text-muted">No problems found with this combination.</p>;
  const order = { ERROR: 0, WARNING: 1, INFO: 2 } as const;
  const tone = { ERROR: TONES.RED, WARNING: TONES.AMBER, INFO: TONES.NEUTRAL } as const;
  const word = { ERROR: "must fix", WARNING: "check", INFO: "note" } as const;
  return (
    <ul className="flex flex-col gap-2">
      {[...issues].sort((a, b) => order[a.severity] - order[b.severity]).map((i) => (
        <li key={`${i.code}-${i.message}`} className="flex items-start gap-2 text-sm">
          <span className={`mt-0.5 inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none ${tone[i.severity]}`}>{word[i.severity]}</span>
          <span>{i.message}</span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------------------------------------ the browser preview

const KEYFRAMES = `
@keyframes rp-fade-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes rp-fade-out { from { opacity: 1 } to { opacity: 0 } }
@keyframes rp-slide-up { from { opacity: 0; transform: translate(-50%, calc(-50% + 12%)) } to { opacity: 1; transform: translate(-50%, -50%) } }
@keyframes rp-slide-down { from { opacity: 1; transform: translate(-50%, -50%) } to { opacity: 0; transform: translate(-50%, calc(-50% + 12%)) } }
@keyframes rp-zoom-in { from { opacity: 0; transform: translate(-50%, -50%) scale(0.85) } to { opacity: 1; transform: translate(-50%, -50%) scale(1) } }
@keyframes rp-slide-up-n { from { opacity: 0; transform: translateY(24%) } to { opacity: 1; transform: none } }
@keyframes rp-slide-down-n { from { opacity: 1; transform: none } to { opacity: 0; transform: translateY(24%) } }
@keyframes rp-zoom-in-n { from { opacity: 0; transform: scale(0.85) } to { opacity: 1; transform: none } }
`;

const PLACEHOLDER_TEXT = "Your text appears here";

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(m.matches);
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** How many units (characters or lines) of the text are visible, over time, for the reveal animations. */
function useReveal(total: number, enabled: boolean, durationMs: number, replayKey: number): number {
  const [count, setCount] = useState(total);
  useEffect(() => {
    if (!enabled) {
      setCount(total);
      return;
    }
    setCount(0);
    const started = performance.now();
    const id = setInterval(() => {
      const progress = Math.min(1, (performance.now() - started) / durationMs);
      setCount(Math.ceil(progress * total));
      if (progress >= 1) clearInterval(id);
    }, 50);
    return () => clearInterval(id);
  }, [total, enabled, durationMs, replayKey]);
  return count;
}

/**
 * The composition as the saved settings define it, drawn in the browser. It is a PREVIEW: the final file is made by the
 * renderer, which wraps text with its own font files, so line breaks can differ slightly. Positions and sizes come from
 * the same layout the renderer will use (computeLayout), as fractions of the frame, so they hold at any size.
 */
export function RecipePreview({ evaluation, replayKey }: { evaluation: Evaluation; replayKey: number }) {
  const { values: v } = evaluation.effective;
  const { layout } = evaluation;
  const asset = evaluation.asset;
  const reduced = usePrefersReducedMotion();
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.2);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setScale(el.clientHeight / layout.frame.height);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout.frame.height]);

  const font = fontById(v.font);
  const raw = evaluation.text?.text ?? PLACEHOLDER_TEXT;
  const text = v.transform === "UPPERCASE" ? raw.toLocaleUpperCase() : raw;
  const motionDuration = (asset?.kind === "VIDEO" && asset.facts.durationMs !== null && v.durationMode === "SOURCE" ? asset.facts.durationMs : v.durationSeconds * 1000) || 5000;
  const animateText = !reduced && v.textAnimation !== "NONE";
  const hasMotion = !reduced && (v.textAnimation !== "NONE" || v.entryAnimation !== "NONE" || v.exitAnimation !== "NONE");
  // the preview plays one cycle of at most 8 s, then starts again, so there is always something to see
  const loopMs = Math.min(motionDuration, 8000);
  const [cycle, setCycle] = useState(0);
  useEffect(() => {
    setCycle(0);
    if (!hasMotion) return;
    const id = setInterval(() => setCycle((c) => c + 1), loopMs + 700);
    return () => clearInterval(id);
  }, [hasMotion, loopMs, replayKey]);
  const runKey = replayKey * 1000 + cycle;
  const lines = text.includes("\n") ? text.split("\n") : splitIntoCues(text, 5);
  const revealTotal = v.textAnimation === "TYPEWRITER" ? [...text].length : lines.length;
  const revealed = useReveal(revealTotal, animateText, Math.min(Math.max(loopMs * 0.5, 1200), 6000), runKey);

  // entry and exit: a block centred with translate(-50%, -50%) needs keyframes that keep that offset; a band does not
  const buildAnimations = (suffix: "" | "-n"): string[] => {
    if (reduced) return [];
    const out: string[] = [];
    const entry = { FADE_IN: "rp-fade-in", SLIDE_UP: `rp-slide-up${suffix}`, ZOOM_IN: `rp-zoom-in${suffix}` }[v.entryAnimation as "FADE_IN"];
    const exit = { FADE_OUT: "rp-fade-out", SLIDE_DOWN: `rp-slide-down${suffix}` }[v.exitAnimation as "FADE_OUT"];
    if (entry) out.push(`${entry} ${v.entryMs}ms ease-out both`);
    if (exit) out.push(`${exit} ${v.exitMs}ms ease-in ${Math.max(0, loopMs - v.exitMs)}ms forwards`);
    return out;
  };
  const animations = buildAnimations("");
  const innerAnimations = buildAnimations("-n");

  const cues = splitIntoCues(raw, v.subtitlesWordsPerCue);
  const [cue, setCue] = useState(0);
  useEffect(() => {
    setCue(0);
    if (!v.subtitlesEnabled || cues.length < 2 || reduced) return;
    const id = setInterval(() => setCue((c) => (c + 1) % cues.length), 1400);
    return () => clearInterval(id);
  }, [v.subtitlesEnabled, cues.length, reduced, replayKey]);

  const fit = v.fit === "COVER" ? "cover" : "contain";
  const maxWidth = layout.frame.width > layout.frame.height ? 520 : layout.frame.width === layout.frame.height ? 380 : 300;
  const fontSize = Math.max(6, layout.fontSizePx * scale);
  const padding = layout.paddingPx * scale;
  const bg = layout.background;
  const bgColor = hexToRgba(bg.color, bg.opacity);
  const textStyle: React.CSSProperties = {
    fontFamily: font?.css,
    fontWeight: v.weight === "BOLD" ? 700 : 400,
    fontSize,
    lineHeight: 1.2,
    color: v.color,
    textAlign: layout.block.align.toLowerCase() as "left" | "center" | "right",
    textShadow: v.shadow ? `0 ${fontSize * 0.04}px ${fontSize * 0.14}px rgba(0,0,0,0.75)` : undefined,
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
  };

  const body =
    v.textAnimation === "TYPEWRITER" && animateText ? (
      <>
        {[...text].slice(0, revealed).join("")}
        <span style={{ visibility: "hidden" }}>{[...text].slice(revealed).join("")}</span>
      </>
    ) : v.textAnimation === "LINE_BY_LINE" && animateText ? (
      lines.map((l, i) => (
        <span key={i} style={{ display: "block", opacity: i < revealed ? 1 : 0, transition: reduced ? undefined : "opacity 400ms" }}>
          {l}
        </span>
      ))
    ) : (
      text
    );

  const blockStyle: React.CSSProperties =
    bg.mode === "BAND"
      ? { left: 0, width: "100%", top: `${layout.block.centerYPct}%`, transform: "translate(0, -50%)", background: bgColor, padding: `${padding}px ${(100 - layout.block.widthPct) / 2}%`, boxSizing: "border-box" }
      : { left: "50%", width: `${layout.block.widthPct}%`, top: `${layout.block.centerYPct}%`, transform: "translate(-50%, -50%)", boxSizing: "border-box", ...(bg.mode === "BOX" ? { background: bgColor, padding } : {}) };
  // the entry/exit animations move the same element, so they own the transform while they run
  const animated = animations.length > 0 && bg.mode !== "BAND";

  return (
    <div className="flex flex-col items-center gap-2">
      <style>{KEYFRAMES}</style>
      <div ref={frameRef} className="relative w-full overflow-hidden rounded border border-border bg-black" style={{ aspectRatio: `${layout.frame.width} / ${layout.frame.height}`, maxWidth }} role="img" aria-label={`Preview of the composition, ${v.aspectRatio}`}>
        {asset && asset.kind === "IMAGE" && asset.contentUrl && <img src={mediaUrl(asset.contentUrl)} alt="" className="absolute inset-0 h-full w-full" style={{ objectFit: fit }} />}
        {asset && asset.kind === "VIDEO" && asset.contentUrl && (
          <video ref={videoRef} src={mediaUrl(asset.contentUrl)} poster={mediaUrl(asset.thumbnailUrl)} muted loop playsInline preload="metadata" className="absolute inset-0 h-full w-full" style={{ objectFit: fit }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
        )}
        {(!asset || !asset.contentUrl) && (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-neutral-800 to-neutral-950 p-4 text-center text-xs text-neutral-400">{asset ? "This file has no stored original to show." : "Choose a picture or a video to see it behind the text."}</div>
        )}

        <div key={runKey} className="absolute" style={{ ...blockStyle, ...(animated ? { animation: animations.join(", ") } : {}) }}>
          {bg.mode === "BAND" && innerAnimations.length > 0 ? (
            <div style={{ animation: innerAnimations.join(", ") }}><div style={textStyle}>{body}</div></div>
          ) : (
            <div style={textStyle}>{body}</div>
          )}
        </div>

        {v.subtitlesEnabled && cues.length > 0 && (
          <div className="absolute left-1/2 w-[86%] -translate-x-1/2 -translate-y-1/2 text-center" style={{ top: `${layout.subtitleCenterYPct}%` }}>
            <span style={{ fontFamily: font?.css, fontWeight: 700, fontSize: Math.max(6, fontSize * 0.55), color: v.subtitlesColor, background: v.subtitlesBackground ? "rgba(0,0,0,0.6)" : undefined, padding: v.subtitlesBackground ? "0.15em 0.4em" : undefined, textShadow: "0 1px 2px rgba(0,0,0,.8)", boxDecorationBreak: "clone" }}>{cues[cue]}</span>
          </div>
        )}

        <span className="pointer-events-none absolute left-1.5 top-1.5 rounded border border-white/30 bg-black/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white">Preview · not a rendered file</span>
        {asset?.kind === "VIDEO" && asset.contentUrl && (
          <button type="button" onClick={() => { const el = videoRef.current; if (!el) return; if (el.paused) void el.play(); else el.pause(); }} className="absolute bottom-1.5 right-1.5 rounded border border-white/30 bg-black/60 px-2 py-1 text-[11px] text-white hover:bg-black/80">
            {playing ? "Pause video" : "Play video"}
          </button>
        )}
      </div>
      <p className="max-w-sm text-center text-xs text-muted">
        {layout.frame.width} × {layout.frame.height} px output. {evaluation.text ? "" : "Placeholder text: choose a text to see yours. "}
        {reduced && (v.textAnimation !== "NONE" || v.entryAnimation !== "NONE" || v.exitAnimation !== "NONE") ? "Motion is not played because your system asks for reduced motion. " : ""}
        The final file is made by the renderer; line breaks and font files can differ slightly.
      </p>
    </div>
  );
}

function hexToRgba(hex: string, opacity: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return `rgba(0,0,0,${opacity})`;
  return `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${opacity})`;
}
