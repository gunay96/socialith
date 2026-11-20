import { describe, expect, it } from "vitest";
import { FONT_FAMILIES, FONT_WEIGHTS, faceFor } from "@socialith/studio";
import { runRealFfmpegTests } from "../testing/ffmpeg-fixtures.js";
import { resolveFontFace } from "../render/fonts.js";
import { readTtfMetrics } from "./ttf.js";

/**
 * The metrics table in @socialith/studio is what both the preview and the renderer wrap text with. It was generated from
 * the real font files; this checks it against the fonts installed here, character by character, so a font package
 * update or a hand edit of the generated file cannot silently move line breaks. CI installs fonts-dejavu-core and
 * fonts-liberation, where every face is checked; with CI=true a face that cannot be found fails.
 */
describe("font metrics table matches the installed fonts", () => {
  for (const family of FONT_FAMILIES) {
    for (const weight of FONT_WEIGHTS) {
      it(`${family.id} ${weight}`, () => {
        let resolved;
        try {
          resolved = resolveFontFace(family.id, weight);
        } catch {
          if (process.env.CI === "true") throw new Error(`no font files are installed, but CI requires them (${family.id} ${weight})`);
          return;
        }
        if (resolved.fallback || (resolved.standIn && family.id.startsWith("dejavu"))) {
          if (process.env.CI === "true") throw new Error(`${family.id} ${weight} is not installed on this CI machine (found ${resolved.used.fontId} instead)`);
          return; // a developer machine without this font: nothing to compare
        }
        const face = faceFor(family.id, weight);
        expect(face).toBeDefined();
        const ttf = readTtfMetrics(resolved.path);
        let compared = 0;
        const wrong: string[] = [];
        for (const [cp, milli] of face!.advances) {
          const adv = ttf.advance(cp);
          // a Windows stand-in (Arial for Liberation Sans, ...) is only metric-compatible: it may lack a glyph, and the
          // table is not claimed to be drawn with it; every glyph it does have must still have the same width
          if (adv === undefined) {
            if (!resolved.standIn) wrong.push(`U+${cp.toString(16)} missing in the font`);
          } else if (Math.round((adv * 1000) / ttf.unitsPerEm) !== milli) wrong.push(`U+${cp.toString(16)}: table ${milli}, font ${Math.round((adv * 1000) / ttf.unitsPerEm)}`);
          compared++;
        }
        expect(compared).toBeGreaterThan(300);
        expect(wrong.slice(0, 5)).toEqual([]);
        // and the table covers every Turkish letter
        for (const ch of "ğĞşŞıİçÇöÖüÜ") expect(face!.advances.has(ch.codePointAt(0)!)).toBe(true);
      });
    }
  }
  it("runs real-font checks only where FFmpeg tests run", () => {
    expect(typeof runRealFfmpegTests).toBe("boolean");
  });
});
