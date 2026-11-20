import { readFileSync } from "node:fs";

/**
 * A minimal TrueType reader: just what text layout needs (units per em, line metrics, and the advance width of a code
 * point), with no dependency. Used to GENERATE the font metrics table committed in @socialith/studio and to VERIFY it
 * against the installed fonts in tests. It does not shape text, apply kerning or read OpenType layout tables.
 */
export interface TtfMetrics {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  lineGap: number;
  /** Advance width in font units, or undefined when the font has no glyph for the code point. */
  advance(codePoint: number): number | undefined;
  /** Every code point the font maps to a glyph (BMP and beyond). */
  codePoints(): number[];
}

function tables(buf: Buffer): Map<string, { offset: number; length: number }> {
  const out = new Map<string, { offset: number; length: number }>();
  const count = buf.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    out.set(buf.toString("latin1", at, at + 4), { offset: buf.readUInt32BE(at + 8), length: buf.readUInt32BE(at + 12) });
  }
  return out;
}

/** code point -> glyph index, from a Unicode cmap subtable (format 4 or 12). */
function readCmap(buf: Buffer, cmapOffset: number): Map<number, number> {
  const subtables = buf.readUInt16BE(cmapOffset + 2);
  let best: { offset: number; format: number } | null = null;
  for (let i = 0; i < subtables; i++) {
    const rec = cmapOffset + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const offset = cmapOffset + buf.readUInt32BE(rec + 4);
    const format = buf.readUInt16BE(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode || (format !== 4 && format !== 12)) continue;
    if (!best || format === 12) best = { offset, format };
  }
  if (!best) throw new Error("The font has no Unicode cmap (format 4 or 12).");
  const map = new Map<number, number>();
  if (best.format === 12) {
    const groups = buf.readUInt32BE(best.offset + 12);
    for (let g = 0; g < groups; g++) {
      const at = best.offset + 16 + g * 12;
      const start = buf.readUInt32BE(at);
      const end = buf.readUInt32BE(at + 4);
      const glyph = buf.readUInt32BE(at + 8);
      for (let c = start; c <= end; c++) map.set(c, glyph + (c - start));
    }
    return map;
  }
  const segX2 = buf.readUInt16BE(best.offset + 6);
  const endCodes = best.offset + 14;
  const startCodes = endCodes + segX2 + 2;
  const deltas = startCodes + segX2;
  const rangeOffsets = deltas + segX2;
  for (let s = 0; s < segX2 / 2; s++) {
    const end = buf.readUInt16BE(endCodes + s * 2);
    const start = buf.readUInt16BE(startCodes + s * 2);
    const delta = buf.readInt16BE(deltas + s * 2);
    const rangeOffset = buf.readUInt16BE(rangeOffsets + s * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let glyph: number;
      if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
      else {
        const at = rangeOffsets + s * 2 + rangeOffset + (c - start) * 2;
        const raw = buf.readUInt16BE(at);
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyph !== 0) map.set(c, glyph);
    }
  }
  return map;
}

export function readTtfMetrics(path: string): TtfMetrics {
  const buf = readFileSync(path);
  const t = tables(buf);
  const need = (name: string) => {
    const e = t.get(name);
    if (!e) throw new Error(`${path}: missing '${name}' table (not a plain TrueType font).`);
    return e;
  };
  const head = need("head");
  const hhea = need("hhea");
  const hmtx = need("hmtx");
  const unitsPerEm = buf.readUInt16BE(head.offset + 18);
  const ascent = buf.readInt16BE(hhea.offset + 4);
  const descent = buf.readInt16BE(hhea.offset + 6);
  const lineGap = buf.readInt16BE(hhea.offset + 8);
  const metricCount = buf.readUInt16BE(hhea.offset + 34);
  const cmap = readCmap(buf, need("cmap").offset);
  const advanceOfGlyph = (g: number) => buf.readUInt16BE(hmtx.offset + Math.min(g, metricCount - 1) * 4);
  return {
    unitsPerEm,
    ascent,
    descent,
    lineGap,
    advance: (cp) => {
      const g = cmap.get(cp);
      return g === undefined ? undefined : advanceOfGlyph(g);
    },
    codePoints: () => [...cmap.keys()].sort((a, b) => a - b),
  };
}
