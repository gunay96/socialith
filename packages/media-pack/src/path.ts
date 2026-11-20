import type { MediaLimits } from "./limits.js";

export type PathRejectionCode = "PATH_TRAVERSAL" | "PATH_ABSOLUTE" | "PATH_INVALID" | "PATH_TOO_LONG" | "PATH_TOO_DEEP";

export type SanitizedPath =
  | { ok: true; path: string; folder: string; fileName: string }
  | { ok: false; code: PathRejectionCode; message: string };

/** Files that operating systems and archivers add by themselves; they are skipped silently, never stored. */
export function isJunkEntry(path: string): boolean {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  return segments[0] === "__MACOSX" || name === ".DS_Store" || name === "Thumbs.db" || name === "desktop.ini" || name.startsWith("._");
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Turns an archive entry name into a safe, relative, forward-slash path - or says why it cannot be.
 *
 * The result is only ever used as METADATA (the folder structure shown in the library). Extracted bytes are written to
 * server-generated names, never to a path built from this value, so even a path that slipped through could not escape
 * the extraction directory. The checks exist so a hostile archive is refused, not silently "fixed".
 */
export function sanitizeEntryPath(raw: string, limits: Pick<MediaLimits, "zipMaxPathLength" | "zipMaxDepth">): SanitizedPath {
  if (raw.length === 0) return { ok: false, code: "PATH_INVALID", message: "The entry has an empty name." };
  if (raw.includes("\0")) return { ok: false, code: "PATH_INVALID", message: "The entry name contains a NUL character." };
  if (hasControlChars(raw)) return { ok: false, code: "PATH_INVALID", message: "The entry name contains control characters." };

  // Some Windows archivers write backslashes; treat them as separators so "..\\x" cannot hide from the checks below.
  const unified = raw.replace(/\\/g, "/");

  if (unified.startsWith("/")) return { ok: false, code: "PATH_ABSOLUTE", message: `"${raw}" is an absolute path.` };
  if (/^[A-Za-z]:/.test(unified)) return { ok: false, code: "PATH_ABSOLUTE", message: `"${raw}" starts with a drive letter.` };

  const segments = unified.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) return { ok: false, code: "PATH_INVALID", message: "The entry has no usable name." };
  if (segments.some((s) => s === "..")) return { ok: false, code: "PATH_TRAVERSAL", message: `"${raw}" tries to leave the extraction folder ("..").` };

  const path = segments.join("/");
  if (path.length > limits.zipMaxPathLength) return { ok: false, code: "PATH_TOO_LONG", message: `The path is longer than ${limits.zipMaxPathLength} characters.` };
  if (segments.length - 1 > limits.zipMaxDepth) return { ok: false, code: "PATH_TOO_DEEP", message: `The path is nested deeper than ${limits.zipMaxDepth} folders.` };

  const fileName = segments[segments.length - 1]!;
  return { ok: true, path, folder: segments.slice(0, -1).join("/"), fileName };
}
