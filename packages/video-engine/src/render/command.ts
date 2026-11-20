import { fontById, type EffectiveValues, type SubtitlePlan, type TextPlan, type Timeline } from "@socialith/studio";

/**
 * Turns a render plan (the same plan the browser preview draws) into one FFmpeg command.
 *
 * Layout of the filter graph:
 *   [0:v]  source picture or video -> scaled and cropped (or padded) to the frame, frame rate, yuv420p   = base
 *   [1:v]  a transparent layer the size of the text block (lavfi colour source)
 *            background box/band, the text lines (drawtext, one per line or per typewriter step), the fades,
 *            the zoom                                                                                    = layer
 *   base + layer -> overlay (position and slide as expressions of time)                                  -> subtitles -> output
 * The text is drawn on a small layer, not on the whole frame, so entry and exit effects act on the block as a unit and
 * cost little. Line breaks are the plan's: each line is its own drawtext, FFmpeg never wraps.
 *
 * Nothing user-supplied reaches the command line: text goes through text files (expansion off), fonts and text files are
 * referred to by fixed relative names inside the job's own work directory (the command runs there), and everything else
 * is a number or a hex colour produced here.
 */
export interface RenderSource {
  path: string;
  kind: "IMAGE" | "VIDEO";
  hasAudio: boolean;
}

export interface RenderOutput {
  kind: "VIDEO" | "IMAGE";
  /** Absolute path of the file to write. */
  path: string;
  durationMs: number;
  fps: number;
  imageFormat: "JPEG" | "PNG";
}

export interface RenderCommandInput {
  source: RenderSource;
  values: EffectiveValues;
  plan: TextPlan;
  timeline: Timeline;
  subtitles: SubtitlePlan;
  output: RenderOutput;
  /** Name of the font file inside the work directory (the runner copies the real font there). */
  fontFile: string;
  /** "-filter_complex_script" (FFmpeg before 7) or "-/filter_complex" (FFmpeg 7 and later). */
  filterScriptFlag: "-filter_complex_script" | "-/filter_complex";
  x264?: { preset: string; crf: number };
}

export interface RenderCommandFile {
  name: string;
  content: string;
}

export interface OutputExpectation {
  kind: "VIDEO" | "IMAGE";
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: "h264" | "mjpeg" | "png";
}

export interface RenderCommand {
  args: string[];
  /** Written into the work directory before the command runs (the filter graph and the text files). */
  files: RenderCommandFile[];
  filtergraph: string;
  expect: OutputExpectation;
}

const num = (n: number): string => String(Number(n.toFixed(3)));
const hex = (color: string): string => `0x${color.replace("#", "").toLowerCase()}`;
const chars = (s: string): string[] => [...s];

function clamp01Expr(expr: string): string {
  return `min(max(${expr},0),1)`;
}

/** The source scaled to fill the frame (cover: crop the overflow) or fit inside it (contain: black bars). */
export function baseFitFilter(v: Pick<EffectiveValues, "fit">, W: number, H: number): string {
  return v.fit === "COVER"
    ? `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`
    : `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`;
}

export function buildRenderCommand(input: RenderCommandInput): RenderCommand {
  const { source, values: v, plan, timeline: tl, subtitles, output } = input;
  const W = plan.frame.width;
  const H = plan.frame.height;
  const isVideoOut = output.kind === "VIDEO";
  const D = output.durationMs / 1000;
  const fps = output.fps;
  const files: RenderCommandFile[] = [];
  const fontsize = plan.fontSizePx;
  const textLines = plan.lines.map((l, i) => ({ l, i })).filter((x) => x.l.length > 0);

  // -- base: the source filling the frame
  const base = [isVideoOut ? `fps=${fps}` : null, baseFitFilter(v, W, H), "setsar=1", "format=yuv420p"].filter(Boolean).join(",");

  // -- layer: the text block
  const layerFilters: string[] = [];
  const layerW = plan.outer.width;
  const layerH = plan.outer.height;
  const hasLayer = textLines.length > 0;
  const bg = plan.background;
  const layerColor = bg.mode !== "NONE" ? bg.color : v.color;
  const shadow = v.shadow ? `:shadowcolor=black@0.75:shadowx=${Math.max(1, Math.round(fontsize * 0.04))}:shadowy=${Math.max(1, Math.round(fontsize * 0.04))}` : "";
  const innerRel = plan.inner.left - plan.outer.left;
  const textCommon = (file: string) => `drawtext=fontfile=${input.fontFile}:textfile=${file}:expansion=none:fontsize=${fontsize}:fontcolor=${hex(v.color)}${shadow}`;
  const yFor = (baseline: number) => `y='${num(baseline - plan.outer.top)}-ascent'`;
  const staticX = () => {
    if (plan.align === "CENTER") return `x='(w-text_w)/2'`;
    if (plan.align === "LEFT") return `x=${innerRel}`;
    return `x='${innerRel + plan.inner.width}-text_w'`;
  };

  if (hasLayer) {
    // The background is the layer's own starting colour (the lavfi input below is created in the background colour at
    // the recipe's opacity). `drawbox replace=1` would do the same but crashes FFmpeg 5.1.9 (Debian 12, the worker
    // image) with a segmentation fault, so it is not used.
    layerFilters.push("format=rgba");
    const reveal = tl.reveal;
    for (const { l, i } of textLines) {
      const writeLine = (name: string, text: string) => files.push({ name, content: text });
      if (reveal.kind === "TYPEWRITER") {
        // the line grows from the left; its left edge comes from the plan so it does not jitter as it grows
        const left = l.leftPx - plan.outer.left;
        const x = `x=${left}`;
        let fullFrom: number | null = null;
        reveal.steps.forEach((s, k) => {
          const c = Math.min(Math.max(s.chars - l.startChar, 0), l.length);
          if (c === 0) return;
          const from = s.atMs / 1000;
          if (c === l.length) {
            if (fullFrom === null) fullFrom = from;
            return;
          }
          const until = (k + 1 < reveal.steps.length ? reveal.steps[k + 1]!.atMs : tl.durationMs) / 1000;
          const name = `tw_${i}_${k}.txt`;
          writeLine(name, chars(l.text).slice(0, c).join(""));
          layerFilters.push(`${textCommon(name)}:${x}:${yFor(l.baselinePx)}:enable='gte(t,${num(from)})*lt(t,${num(until)})'`);
        });
        if (fullFrom !== null) {
          const name = `line_${i}.txt`;
          writeLine(name, l.text);
          layerFilters.push(`${textCommon(name)}:${x}:${yFor(l.baselinePx)}:enable='gte(t,${num(fullFrom)})'`);
        }
      } else if (reveal.kind === "LINE_BY_LINE") {
        const name = `line_${i}.txt`;
        writeLine(name, l.text);
        const at = (reveal.lineStartsMs[i] ?? 0) / 1000;
        const fade = reveal.lineFadeMs / 1000;
        layerFilters.push(`${textCommon(name)}:${staticX()}:${yFor(l.baselinePx)}:enable='gte(t,${num(at)})':alpha='${clamp01Expr(`(t-${num(at)})/${num(fade)}`)}'`);
      } else {
        const name = `line_${i}.txt`;
        writeLine(name, l.text);
        layerFilters.push(`${textCommon(name)}:${staticX()}:${yFor(l.baselinePx)}`);
      }
    }
    // entry and exit: the block fades (all kinds), slides and/or zooms
    if (tl.entry.kind !== "NONE" && tl.entry.ms > 0) layerFilters.push(`fade=t=in:st=0:d=${num(tl.entry.ms / 1000)}:alpha=1`);
    if (tl.exit.kind !== "NONE" && tl.exit.ms > 0) layerFilters.push(`fade=t=out:st=${num(D - tl.exit.ms / 1000)}:d=${num(tl.exit.ms / 1000)}:alpha=1`);
    if (tl.entry.kind === "ZOOM_IN" && tl.entry.ms > 0) {
      const p = clamp01Expr(`t/${num(tl.entry.ms / 1000)}`);
      const z = `(${num(tl.zoomFrom)}+${num(1 - tl.zoomFrom)}*(1-pow(1-${p},3)))`;
      layerFilters.push(`scale=w='trunc(iw*${z}/2)*2':h='trunc(ih*${z}/2)*2':eval=frame:flags=bicubic`);
    }
  }

  // -- overlay position: fixed, or centre-based expressions when the block slides or zooms
  const slides = tl.entry.kind === "SLIDE_UP" || tl.exit.kind === "SLIDE_DOWN";
  const zooms = tl.entry.kind === "ZOOM_IN" && tl.entry.ms > 0;
  let overlay = `overlay=x=${plan.outer.left}:y=${plan.outer.top}:format=auto:eval=init`;
  if (hasLayer && (slides || zooms)) {
    const cx = plan.outer.left + layerW / 2;
    const cy = plan.outer.top + layerH / 2;
    const terms: string[] = [];
    if (tl.entry.kind === "SLIDE_UP" && tl.entry.ms > 0) terms.push(`${tl.slidePx}*pow(1-${clamp01Expr(`t/${num(tl.entry.ms / 1000)}`)},3)`);
    if (tl.exit.kind === "SLIDE_DOWN" && tl.exit.ms > 0) terms.push(`${tl.slidePx}*pow(${clamp01Expr(`(t-${num(D - tl.exit.ms / 1000)})/${num(tl.exit.ms / 1000)}`)},3)`);
    overlay = `overlay=x='${num(cx)}-w/2':y='${num(cy)}-h/2${terms.length ? `+${terms.join("+")}` : ""}':format=auto:eval=frame`;
  }

  // -- subtitles drawn on the composited frame
  const subtitleFilters: string[] = [];
  if (subtitles.enabled) {
    for (const cue of subtitles.cues) {
      cue.lines.forEach((line, k) => {
        if (line.text === "") return;
        const name = `sub_${cue.index}_${k}.txt`;
        files.push({ name, content: line.text });
        const box = v.subtitlesBackground ? `:box=1:boxcolor=black@0.6:boxborderw=${cue.boxPaddingPx}` : `:shadowcolor=black@0.8:shadowx=2:shadowy=2`;
        subtitleFilters.push(
          `drawtext=fontfile=${input.fontFile}:textfile=${name}:expansion=none:fontsize=${subtitles.fontSizePx}:fontcolor=${hex(v.subtitlesColor)}${box}:x=${line.leftPx}:y='${line.baselinePx}-ascent':enable='gte(t,${num(cue.startMs / 1000)})*lt(t,${num(cue.endMs / 1000)})'`,
        );
      });
    }
  }

  // -- the graph
  const tail = [...subtitleFilters, output.kind === "IMAGE" ? (output.imageFormat === "JPEG" ? "format=yuvj420p" : "format=rgb24") : "format=yuv420p"].join(",");
  const graph = hasLayer
    ? [`[0:v]${base}[base]`, `[1:v]${layerFilters.join(",")}[layer]`, `[base][layer]${overlay}[composited]`, `[composited]${tail}[vout]`].join(";\n")
    : [`[0:v]${base},${tail}[vout]`].join(";\n");
  files.push({ name: "graph.txt", content: graph });

  // -- inputs and outputs
  const args: string[] = ["-hide_banner", "-v", "error", "-y", "-nostdin"];
  if (source.kind === "IMAGE" && isVideoOut) args.push("-loop", "1", "-framerate", String(fps), "-t", num(D));
  args.push("-i", source.path);
  if (hasLayer) args.push("-f", "lavfi", "-i", `color=c=${hex(layerColor)}@${bg.mode !== "NONE" ? num(bg.opacity) : "0"}:s=${layerW}x${layerH}:r=${isVideoOut ? fps : 1}:d=${num(isVideoOut ? D : 1)},format=rgba`);
  args.push(input.filterScriptFlag, "graph.txt", "-map", "[vout]");

  const keepAudio = isVideoOut && source.kind === "VIDEO" && source.hasAudio;
  if (isVideoOut) {
    if (keepAudio) args.push("-map", "0:a:0", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2");
    else args.push("-an");
    const x264 = input.x264 ?? { preset: "veryfast", crf: 21 };
    args.push("-c:v", "libx264", "-preset", x264.preset, "-crf", String(x264.crf), "-profile:v", "high", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-movflags", "+faststart", "-map_metadata", "-1", "-t", num(D));
  } else {
    args.push("-frames:v", "1", "-map_metadata", "-1");
    if (output.imageFormat === "JPEG") args.push("-c:v", "mjpeg", "-q:v", "2");
    else args.push("-c:v", "png");
  }
  args.push("-progress", "pipe:1", "-nostats", output.path);

  return {
    args,
    files,
    filtergraph: graph,
    expect: { kind: output.kind, width: W, height: H, durationMs: output.durationMs, fps, hasAudio: keepAudio, videoCodec: isVideoOut ? "h264" : output.imageFormat === "JPEG" ? "mjpeg" : "png" },
  };
}

/** What the recipe's font is, for the report (the file used is decided by resolveFontFace). */
export function fontLabel(fontId: string): string {
  return fontById(fontId)?.label ?? fontId;
}
