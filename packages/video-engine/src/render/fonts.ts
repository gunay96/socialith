import { existsSync } from "node:fs";
import { join } from "node:path";
import { FONT_FAMILIES, fontById, type FontWeight } from "@socialith/studio";

/**
 * Finding the real font file for a recipe's font, and saying so when it is not there.
 *
 * Order: the font's own file in the configured directories (on the worker image: DejaVu and Liberation); a
 * metric-compatible stand-in on a developer's Windows machine (Arial for Liberation Sans and so on: the same advance
 * widths by design, so line breaks do not move); then ANY other installed family from the catalogue, reported as a
 * fallback with the reason. If no font at all can be found the render is refused with the directories that were searched.
 */
export const DEFAULT_FONT_DIRS = ["/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/truetype/liberation", "/usr/share/fonts/truetype/liberation2", "/usr/share/fonts/dejavu", "/usr/share/fonts/liberation"];

const WINDOWS_STAND_INS: Record<string, Record<FontWeight, string>> = {
  "liberation-sans": { REGULAR: "arial.ttf", BOLD: "arialbd.ttf" },
  "liberation-serif": { REGULAR: "times.ttf", BOLD: "timesbd.ttf" },
  "liberation-mono": { REGULAR: "cour.ttf", BOLD: "courbd.ttf" },
};
const WINDOWS_FONT_DIR = "C:\\Windows\\Fonts";

export interface FontResolution {
  requested: { fontId: string; weight: FontWeight };
  /** The font actually used. Line breaks are planned for THIS font. */
  used: { fontId: string; weight: FontWeight };
  path: string;
  /** A different family had to be used because the requested one is not installed. */
  fallback: boolean;
  /** A metric-compatible stand-in of the same family (development machines only). */
  standIn: boolean;
  /** What a person should know; empty when the requested font was used as is. */
  note: string | null;
}

export class FontsUnavailableError extends Error {
  constructor(
    message: string,
    readonly searched: string[],
  ) {
    super(message);
    this.name = "FontsUnavailableError";
  }
}

export interface ResolveOptions {
  dirs?: string[];
  exists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
}

export function resolveFontFace(fontId: string, weight: FontWeight, options: ResolveOptions = {}): FontResolution {
  const dirs = options.dirs?.length ? options.dirs : DEFAULT_FONT_DIRS;
  const exists = options.exists ?? existsSync;
  const platform = options.platform ?? process.platform;
  const searched: string[] = [...dirs];
  const own = (id: string, w: FontWeight): { path: string; standIn: boolean } | null => {
    const file = fontById(id)?.files[w];
    if (file) for (const dir of dirs) if (exists(join(dir, file))) return { path: join(dir, file), standIn: false };
    const stand = platform === "win32" ? WINDOWS_STAND_INS[id]?.[w] : undefined;
    if (stand && exists(join(WINDOWS_FONT_DIR, stand))) return { path: join(WINDOWS_FONT_DIR, stand), standIn: true };
    return null;
  };

  const direct = own(fontId, weight);
  if (direct) {
    return {
      requested: { fontId, weight },
      used: { fontId, weight },
      path: direct.path,
      fallback: false,
      standIn: direct.standIn,
      note: direct.standIn ? `The font file for "${fontById(fontId)?.label ?? fontId}" is not installed on this machine; a metric-compatible stand-in was used (same letter widths, slightly different shapes).` : null,
    };
  }
  // the same family in the other weight is not a fallback worth hiding behind: say what happened and try other families
  for (const family of FONT_FAMILIES) {
    if (family.id === fontId) continue;
    const found = own(family.id, weight);
    if (found) {
      return {
        requested: { fontId, weight },
        used: { fontId: family.id, weight },
        path: found.path,
        fallback: true,
        standIn: found.standIn,
        note: `The font "${fontById(fontId)?.label ?? fontId}" (${weight.toLowerCase()}) is not installed on the worker, so "${family.label}" was used instead. Line breaks were planned for the font that was used. An administrator can install the missing font package.`,
      };
    }
  }
  throw new FontsUnavailableError(`No usable font file was found (looked in ${searched.join(", ")}).`, searched);
}
