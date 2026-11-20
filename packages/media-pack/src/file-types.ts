import { extname } from "node:path";

export type MediaKind = "VIDEO" | "IMAGE" | "AUDIO" | "TEXT" | "SPREADSHEET" | "ARCHIVE";

export type SignatureKind = "mp4" | "mov" | "jpeg" | "png" | "webp" | "mp3" | "wav" | "zip" | "text";

export interface FileTypeInfo {
  /** Lower-case extension including the dot. */
  ext: string;
  kind: MediaKind;
  /** The MIME type we store and serve. */
  mime: string;
  /** Client-declared MIME types we accept for this extension (beyond the generic ones). */
  acceptedMimes: string[];
  /** The byte signature the content must show. */
  signature: SignatureKind;
}

/**
 * The only file types the media library accepts. Anything else is rejected with an explicit reason. The extension is
 * only the *claim*: the signature and the declared MIME type must agree with it (validateUpload).
 */
export const FILE_TYPES: Readonly<Record<string, FileTypeInfo>> = {
  ".mp4": { ext: ".mp4", kind: "VIDEO", mime: "video/mp4", acceptedMimes: ["video/mp4", "video/x-m4v"], signature: "mp4" },
  ".mov": { ext: ".mov", kind: "VIDEO", mime: "video/quicktime", acceptedMimes: ["video/quicktime", "video/mp4"], signature: "mov" },
  ".jpg": { ext: ".jpg", kind: "IMAGE", mime: "image/jpeg", acceptedMimes: ["image/jpeg", "image/pjpeg"], signature: "jpeg" },
  ".jpeg": { ext: ".jpeg", kind: "IMAGE", mime: "image/jpeg", acceptedMimes: ["image/jpeg", "image/pjpeg"], signature: "jpeg" },
  ".png": { ext: ".png", kind: "IMAGE", mime: "image/png", acceptedMimes: ["image/png"], signature: "png" },
  ".webp": { ext: ".webp", kind: "IMAGE", mime: "image/webp", acceptedMimes: ["image/webp"], signature: "webp" },
  ".mp3": { ext: ".mp3", kind: "AUDIO", mime: "audio/mpeg", acceptedMimes: ["audio/mpeg", "audio/mp3"], signature: "mp3" },
  ".wav": { ext: ".wav", kind: "AUDIO", mime: "audio/wav", acceptedMimes: ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"], signature: "wav" },
  ".txt": { ext: ".txt", kind: "TEXT", mime: "text/plain", acceptedMimes: ["text/plain"], signature: "text" },
  ".csv": { ext: ".csv", kind: "SPREADSHEET", mime: "text/csv", acceptedMimes: ["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain"], signature: "text" },
  ".xlsx": {
    ext: ".xlsx",
    kind: "SPREADSHEET",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    acceptedMimes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    signature: "zip",
  },
  ".zip": { ext: ".zip", kind: "ARCHIVE", mime: "application/zip", acceptedMimes: ["application/zip", "application/x-zip-compressed", "multipart/x-zip"], signature: "zip" },
};

/** Browsers send these for anything they cannot classify; they carry no information, so they never cause a mismatch. */
const GENERIC_MIMES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

export function extensionOf(fileName: string): string {
  return extname(fileName).toLowerCase();
}

export function fileTypeFor(fileName: string): FileTypeInfo | null {
  return FILE_TYPES[extensionOf(fileName)] ?? null;
}

export function normalizeMime(declared: string | null | undefined): string {
  return (declared ?? "").split(";")[0]!.trim().toLowerCase();
}

export function isGenericMime(mime: string): boolean {
  return GENERIC_MIMES.has(mime);
}

export const ACCEPTED_EXTENSIONS: readonly string[] = Object.keys(FILE_TYPES);
