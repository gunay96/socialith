"use client";

import { useEffect, useRef, useState } from "react";
import { fontById, describeSource, stateAt, type EffectiveValues, type RecipeConfig, type SettingSource, type SubtitlePlan, type TextLayout, type TextPlan, type Timeline } from "@socialith/studio";
import { formatDurationMs, mediaUrl, type AssetDto } from "@/lib/studio";
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
  /** The exact line breaks, sizes and positions the renderer will use (the same calculation, run on the server). */
  plan: TextPlan;
  timeline: Timeline;
  subtitles: SubtitlePlan;
  /** What would be made from the chosen media: a video of this length, or a still. Null when no media is chosen or it cannot be used. */
  output: { kind: "VIDEO" | "IMAGE"; durationMs: number } | null;
  /** True when no text was chosen and a stand-in is drawn. */
  placeholder: boolean;
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

/** A moment where entry and reveal are finished and the exit has not begun: what a viewer who asks for no motion is shown. */
export function restingTimeMs(tl: Timeline): number {
  const settled = Math.max(tl.entry.ms, tl.reveal.kind === "NONE" ? 0 : tl.reveal.durationMs + tl.reveal.lineFadeMs);
  return Math.min(Math.max(0, tl.durationMs - tl.exit.ms - 1), settled + 100);
}

/** A clock for the preview: real time from the animation frames, looping with a short hold at the end, and a scrubber. */
function usePlayback(durationMs: number, autoplay: boolean, startMs: number, resetKey: number) {
  const [t, setT] = useState(startMs);
  const [playing, setPlaying] = useState(autoplay);
  const tRef = useRef(startMs);
  useEffect(() => {
    tRef.current = autoplay ? 0 : startMs;
    setT(tRef.current);
    setPlaying(autoplay);
  }, [resetKey, durationMs, autoplay, startMs]);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      let next = tRef.current + (now - last);
      last = now;
      if (next >= durationMs + 700) next = 0;
      tRef.current = next;
      setT(Math.min(next, durationMs));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, durationMs]);
  const seek = (ms: number) => {
    tRef.current = ms;
    setT(ms);
  };
  return { t, playing, setPlaying, seek };
}

/**
 * The composition drawn in the browser from the SAME plan and timeline the renderer follows: every line is placed at the
 * pixel the renderer places it (line breaks, size, baseline, box or band, safe area), and the animations are the numbers
 * on the timeline evaluated at the playhead (stateAt), not a separate CSS animation. What can still differ from the
 * rendered file: the browser draws the glyphs with its own font files, and FFmpeg's compositing and compression.
 */
export function RecipePreview({ evaluation, replayKey }: { evaluation: Evaluation; replayKey: number }) {
  const { values: v } = evaluation.effective;
  const { plan, timeline, subtitles, asset, output } = evaluation;
  const reduced = usePrefersReducedMotion();
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [scale, setScale] = useState(0.2);
  const [showSafe, setShowSafe] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setScale(el.clientWidth / plan.frame.width);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [plan.frame.width]);

  const still = output?.kind === "IMAGE";
  const durationMs = timeline.durationMs;
  const hasMotion = !still && (timeline.entry.kind !== "NONE" || timeline.exit.kind !== "NONE" || timeline.reveal.kind !== "NONE" || (subtitles.enabled && subtitles.cues.length > 1) || asset?.kind === "VIDEO");
  const rest = restingTimeMs(timeline);
  const { t, playing, setPlaying, seek } = usePlayback(durationMs, hasMotion && !reduced, still ? 0 : rest, replayKey);

  // the video behind the text follows the same playhead: it plays with the clock and is set to the scrubbed time otherwise
  const lastT = useRef(0);
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (playing) {
      if (t < lastT.current - 200 || el.paused) el.currentTime = t / 1000;
      void el.play().catch(() => undefined);
    } else {
      el.pause();
      if (Math.abs(el.currentTime * 1000 - t) > 80) el.currentTime = t / 1000;
    }
    lastT.current = t;
  }, [playing, t]);

  const font = fontById(v.font);
  const st = stateAt(timeline, plan, still ? 0 : t);
  const fit = v.fit === "COVER" ? "cover" : "contain";
  const maxWidth = plan.frame.width > plan.frame.height ? 520 : plan.frame.width === plan.frame.height ? 380 : 300;
  const bg = plan.background;
  const shadowPx = Math.max(1, Math.round(plan.fontSizePx * 0.04));
  const lineStyle = (extra: React.CSSProperties): React.CSSProperties => ({
    position: "absolute",
    whiteSpace: "pre",
    fontFamily: font?.css,
    fontWeight: plan.weight === "BOLD" ? 700 : 400,
    color: v.color,
    ...extra,
  });
  const cue = subtitles.enabled ? subtitles.cues.find((c) => t >= c.startMs && t < c.endMs) ?? (t >= durationMs ? subtitles.cues[subtitles.cues.length - 1] : undefined) : undefined;
  const sub = subtitles.enabled && !still ? subtitles : null;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-full" style={{ maxWidth }}>
        <div
          ref={wrapRef}
          className="relative w-full overflow-hidden rounded border border-border bg-black"
          style={{ aspectRatio: `${plan.frame.width} / ${plan.frame.height}` }}
          role="img"
          aria-label={`Preview of the composition, ${v.aspectRatio}, at ${formatDurationMs(t)}`}
        >
          {asset && asset.kind === "IMAGE" && asset.contentUrl && <img src={mediaUrl(asset.contentUrl)} alt="" className="absolute inset-0 h-full w-full" style={{ objectFit: fit }} />}
          {asset && asset.kind === "VIDEO" && asset.contentUrl && (
            <video ref={videoRef} src={mediaUrl(asset.contentUrl)} poster={mediaUrl(asset.thumbnailUrl)} muted playsInline preload="metadata" className="absolute inset-0 h-full w-full" style={{ objectFit: fit }} />
          )}
          {(!asset || !asset.contentUrl) && (
            <div className="absolute inset-0 flex items-end justify-center bg-gradient-to-b from-neutral-800 to-neutral-950 p-3 text-center text-[11px] text-neutral-400">{asset ? "This file has no stored original to show." : "Choose a picture or a video to see it behind the text."}</div>
          )}

          {/* the frame in output pixels, scaled to fit: positions are the renderer's own */}
          <div className="pointer-events-none absolute left-0 top-0 origin-top-left" style={{ width: plan.frame.width, height: plan.frame.height, transform: `scale(${scale})` }}>
            {plan.lines.length > 0 && (
              <div
                className="absolute"
                style={{
                  left: plan.outer.left,
                  top: plan.outer.top,
                  width: plan.outer.width,
                  height: plan.outer.height,
                  opacity: st.opacity,
                  transform: `translateY(${st.offsetYPx}px) scale(${st.scale})`,
                  transformOrigin: "50% 50%",
                  background: bg.mode === "NONE" ? undefined : hexToRgba(bg.color, bg.opacity),
                }}
              >
                {plan.lines.map((l, i) => {
                  const visible = timeline.reveal.kind === "TYPEWRITER" ? Math.max(0, Math.min(l.length, st.visibleChars - l.startChar)) : l.length;
                  const shown = visible >= l.length ? l.text : [...l.text].slice(0, visible).join("");
                  if (shown.length === 0) return null;
                  return (
                    <span
                      key={i}
                      style={lineStyle({
                        left: l.leftPx - plan.outer.left,
                        top: l.topPx - plan.outer.top,
                        height: plan.stepPx,
                        lineHeight: `${plan.stepPx}px`,
                        fontSize: plan.fontSizePx,
                        opacity: st.lineAlpha[i] ?? 1,
                        textShadow: v.shadow ? `${shadowPx}px ${shadowPx}px 0 rgba(0,0,0,0.75)` : undefined,
                      })}
                    >
                      {shown}
                    </span>
                  );
                })}
              </div>
            )}

            {sub && cue && cue.lines.map((l, i) => (
              <div key={`${cue.index}-${i}`}>
                {v.subtitlesBackground && <div className="absolute" style={{ left: l.leftPx - cue.boxPaddingPx, top: l.topPx - cue.boxPaddingPx, width: l.widthPx + cue.boxPaddingPx * 2, height: sub.stepPx + cue.boxPaddingPx * 2, background: "rgba(0,0,0,0.6)" }} />}
                <span style={lineStyle({ left: l.leftPx, top: l.topPx, height: sub.stepPx, lineHeight: `${sub.stepPx}px`, fontSize: sub.fontSizePx, fontWeight: 700, color: v.subtitlesColor, textShadow: v.subtitlesBackground ? undefined : "2px 2px 0 rgba(0,0,0,0.8)" })}>{l.text}</span>
              </div>
            ))}

            {showSafe && (
              <div className="absolute border-2 border-dashed border-cyan-300/80" style={{ left: plan.safeArea.left, top: plan.safeArea.top, width: plan.frame.width - plan.safeArea.left - plan.safeArea.right, height: plan.frame.height - plan.safeArea.top - plan.safeArea.bottom }} />
            )}
          </div>

          <span className="pointer-events-none absolute left-1.5 top-1.5 rounded border border-white/30 bg-black/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white">Preview · not a rendered file</span>
        </div>
      </div>

      {hasMotion && (
        <div className="flex w-full items-center gap-2" style={{ maxWidth }}>
          <button type="button" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause preview" : "Play preview"} className="w-14 shrink-0 rounded border border-border px-2 py-1 text-xs hover:border-foreground">
            {playing ? "Pause" : "Play"}
          </button>
          <input type="range" min={0} max={durationMs} step={20} value={Math.round(t)} onChange={(e) => { setPlaying(false); seek(Number(e.target.value)); }} aria-label="Preview time" className="min-w-0 flex-1" />
          <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted">{formatDurationMs(t)} / {formatDurationMs(durationMs)}</span>
        </div>
      )}
      <label className="flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" checked={showSafe} onChange={(e) => setShowSafe(e.target.checked)} /> Show the safe area guide (an assumption, not a measured platform rule)
      </label>

      <div className="max-w-sm text-center text-xs text-muted">
        <p>
          {plan.frame.width} × {plan.frame.height} px {still ? "picture" : `video, ${formatDurationMs(durationMs)}`}. Line breaks, size and position are the ones the renderer uses.{" "}
          {evaluation.placeholder ? "Placeholder text: choose a text to see yours. " : ""}
          {still && (v.textAnimation !== "NONE" || v.entryAnimation !== "NONE" || v.exitAnimation !== "NONE") ? "A still picture does not animate; the text is shown complete. " : ""}
          {reduced && hasMotion ? "Motion is paused because your system asks for reduced motion; use Play or the slider. " : ""}
        </p>
        {plan.adjustments.length > 0 && <p className="mt-1 text-amber-400">Adjusted to fit: {plan.adjustments.join("; ")}</p>}
        <p className="mt-1">Your browser draws the letters with its own fonts, so their shape can differ slightly from the file.</p>
      </div>
    </div>
  );
}

export function hexToRgba(hex: string, opacity: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return `rgba(0,0,0,${opacity})`;
  return `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${opacity})`;
}
