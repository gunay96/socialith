import { TextImportError } from "./errors.js";

export type TextEncoding = "utf-8" | "windows-1254";

/**
 * Bytes to text. UTF-8 first (a BOM is dropped). A file that is not valid UTF-8 is read as Windows-1254, the Turkish
 * code page that older Excel and Notepad versions save "CSV" and "TXT" in; the encoding that was used is reported so
 * the person can see it. Binary data (NUL bytes) is refused.
 */
export function decodeTextBytes(bytes: Buffer): { text: string; encoding: TextEncoding } {
  if (bytes.length === 0) throw new TextImportError("EMPTY_FILE", "The file is empty.");
  if (bytes.includes(0)) throw new TextImportError("NOT_TEXT", "This file contains binary data, not text.");
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), encoding: "utf-8" };
  } catch {
    try {
      return { text: new TextDecoder("windows-1254").decode(body), encoding: "windows-1254" };
    } catch {
      throw new TextImportError("NOT_TEXT", "The file is not valid UTF-8. Save it as UTF-8 text and try again.");
    }
  }
}
