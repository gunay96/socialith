import { fileTypeFor, isGenericMime, normalizeMime, type FileTypeInfo, type SignatureKind } from "./file-types.js";

/** How many leading bytes validation needs. Callers read exactly this much of a file - never the whole file. */
export const HEAD_BYTES = 4096;

export type UploadRejectionCode = "UNSUPPORTED_TYPE" | "MIME_MISMATCH" | "SIGNATURE_MISMATCH" | "EMPTY_FILE" | "UTF16_TEXT";

export type UploadValidation = { ok: true; info: FileTypeInfo; detected: SignatureKind } | { ok: false; code: UploadRejectionCode; message: string };

const ascii = (b: Buffer, start: number, end: number) => b.subarray(start, end).toString("latin1");

/** True when the bytes look like (UTF-8 / ASCII) text: no NUL, almost no control characters, valid UTF-8 up to the cut. */
export function looksLikeText(head: Buffer): boolean {
  if (head.length === 0) return false;
  if (head.includes(0x00)) return false;
  let control = 0;
  for (const byte of head) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) control++;
  }
  if (control / head.length > 0.01) return false;
  // a multi-byte character may be cut by the end of the window: drop up to 3 trailing bytes before the strict decode
  for (let trim = 0; trim <= 3 && trim < head.length; trim++) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, head.length - trim));
      return true;
    } catch {
      /* try a shorter window */
    }
  }
  return false;
}

/**
 * Text in a legacy single-byte encoding (Windows-1254 "Turkish ANSI", Windows-1252 ...): no NUL bytes, almost no control
 * characters, but not valid UTF-8. Excel and Notepad on older systems save "CSV" and "TXT" this way. Only the text
 * import accepts it (it decodes it explicitly and says which encoding it used); the media library does not.
 */
export function looksLikeLegacyText(head: Buffer): boolean {
  if (head.length === 0 || head.includes(0x00)) return false;
  let control = 0;
  for (const byte of head) if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) control++;
  return control / head.length <= 0.01;
}

/** The signature the first bytes show, or null when they match none of the types the library accepts. */
export function detectSignature(head: Buffer): SignatureKind | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (head.length >= 12 && ascii(head, 0, 4) === "RIFF") {
    const form = ascii(head, 8, 12);
    if (form === "WEBP") return "webp";
    if (form === "WAVE") return "wav";
  }
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05) && (head[3] === 0x04 || head[3] === 0x06)) return "zip";
  if (head.length >= 3 && ascii(head, 0, 3) === "ID3") return "mp3";
  // MPEG audio frame sync: 11 set bits
  if (head.length >= 2 && head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0) return "mp3";
  if (head.length >= 12 && ascii(head, 4, 8) === "ftyp") return ascii(head, 8, 12) === "qt  " ? "mov" : "mp4";
  // old QuickTime files start with another top-level atom instead of ftyp
  if (head.length >= 8 && ["moov", "mdat", "wide", "free", "skip"].includes(ascii(head, 4, 8))) return "mov";
  if (looksLikeText(head)) return "text";
  return null;
}

/** Signatures that satisfy a claimed signature (MP4 and MOV share the ISO base-media container). */
function satisfies(expected: SignatureKind, detected: SignatureKind | null): boolean {
  if (detected === null) return false;
  if (expected === detected) return true;
  if ((expected === "mp4" && detected === "mov") || (expected === "mov" && detected === "mp4")) return true;
  return false;
}

/**
 * The single gate every file passes before it is stored or processed: the extension must be on the allow-list, the
 * client-declared MIME type (when it says anything) must agree, and the first bytes must show the matching signature.
 */
export function validateUpload(fileName: string, declaredMime: string | null | undefined, head: Buffer): UploadValidation {
  const info = fileTypeFor(fileName);
  if (!info) {
    return { ok: false, code: "UNSUPPORTED_TYPE", message: `"${fileName}" is not a supported file type. Accepted: ZIP, MP4, MOV, JPG, JPEG, PNG, WEBP, MP3, WAV, TXT, CSV, XLSX.` };
  }
  if (head.length === 0) return { ok: false, code: "EMPTY_FILE", message: `"${fileName}" is empty.` };

  const mime = normalizeMime(declaredMime);
  if (!isGenericMime(mime) && !info.acceptedMimes.includes(mime)) {
    return { ok: false, code: "MIME_MISMATCH", message: `"${fileName}" was sent as ${mime}, which does not match a ${info.ext} file.` };
  }

  if (info.signature === "text" && head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) {
    return { ok: false, code: "UTF16_TEXT", message: `"${fileName}" is UTF-16 text. Save it as UTF-8 and upload it again.` };
  }

  // A text file is judged by the text check first: a note that merely starts with the letters "ID3" is not an MP3.
  const detected = info.signature === "text" && looksLikeText(head) ? "text" : detectSignature(head);
  if (!satisfies(info.signature, detected)) {
    return {
      ok: false,
      code: "SIGNATURE_MISMATCH",
      message: `The content of "${fileName}" is ${detected ? `a ${detected} file` : "not a recognised file"}, not a ${info.ext} file. The extension was not trusted.`,
    };
  }
  return { ok: true, info, detected: detected! };
}
