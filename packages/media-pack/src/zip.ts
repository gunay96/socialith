import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { fileTypeFor } from "./file-types.js";
import { MIN_RATIO_CHECK_BYTES, type MediaLimits } from "./limits.js";
import { isJunkEntry, sanitizeEntryPath } from "./path.js";
import { HEAD_BYTES } from "./signature.js";

export type ZipErrorCode =
  | "ZIP_INVALID"
  | "ZIP_ARCHIVE_TOO_LARGE"
  | "ZIP_TOO_MANY_ENTRIES"
  | "ZIP_TOTAL_TOO_LARGE"
  | "ZIP_RATIO_EXCEEDED"
  | "ZIP_BOMB_DETECTED"
  | "ZIP_UNSAFE_PATH"
  | "ZIP_ABORTED";

/** An archive-level refusal: nothing from this archive is extracted (or extraction stops at once). */
export class ZipLimitError extends Error {
  constructor(
    readonly code: ZipErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ZipLimitError";
  }
}

export type EntryRejectionCode =
  | "PATH_INVALID"
  | "PATH_TOO_LONG"
  | "PATH_TOO_DEEP"
  | "SYMLINK_NOT_ALLOWED"
  | "ENCRYPTED"
  | "UNSUPPORTED_COMPRESSION"
  | "DUPLICATE_PATH"
  | "UNSUPPORTED_TYPE"
  | "NESTED_ARCHIVE"
  | "FILE_TOO_LARGE";

export interface ScanEntry {
  /** Position in the archive's central directory; extraction walks the same order. */
  index: number;
  rawName: string;
  /** Sanitized, forward-slash relative path (metadata only). Present unless the name was invalid. */
  entryPath: string | null;
  folder: string;
  fileName: string;
  declaredBytes: number;
  compressedBytes: number;
  verdict: "extract" | "ignore" | "directory" | "reject";
  reject?: { code: EntryRejectionCode; message: string };
}

export interface ZipScan {
  archiveBytes: number;
  entryCount: number;
  entries: ScanEntry[];
  /** Entries that will be extracted. */
  extractable: number;
  rejected: number;
  ignored: number;
  totalDeclaredBytes: number;
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true, decodeStrings: true, strictFileNames: false }, (err, zip) => {
      if (err || !zip) reject(new ZipLimitError("ZIP_INVALID", `This is not a readable ZIP archive (${err?.message ?? "unknown error"}).`));
      else resolve(zip);
    });
  });
}

function nextEntry(zip: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zip.removeListener("entry", onEntry);
      zip.removeListener("end", onEnd);
      zip.removeListener("error", onError);
    };
    const onEntry = (entry: yauzl.Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onError = (err: Error) => {
      cleanup();
      // yauzl refuses unsafe names on its own ("invalid relative path", "absolute path"): same verdict as our own check
      if (/invalid relative path|absolute path/i.test(err.message)) {
        reject(new ZipLimitError("ZIP_UNSAFE_PATH", `The archive contains an unsafe path and was refused (${err.message}).`));
        return;
      }
      reject(new ZipLimitError("ZIP_INVALID", `The ZIP archive is damaged (${err.message}).`));
    };
    zip.once("entry", onEntry);
    zip.once("end", onEnd);
    zip.once("error", onError);
    zip.readEntry();
  });
}

const isSymlink = (entry: yauzl.Entry): boolean => entry.versionMadeBy >> 8 === 3 && ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;

/**
 * First pass, metadata only: nothing is inflated. Enforces every archive-level limit from the *declared* sizes (a
 * header can lie, so extraction enforces them again on the bytes that really come out) and classifies each entry.
 * Throws ZipLimitError when the archive as a whole must be refused: too large, too many entries, too much total data,
 * an implausible compression ratio, or any entry that tries to leave the extraction folder.
 */
export async function scanZip(zipPath: string, limits: MediaLimits): Promise<ZipScan> {
  const { size: archiveBytes } = await stat(zipPath);
  if (archiveBytes > limits.maxArchiveBytes) {
    throw new ZipLimitError("ZIP_ARCHIVE_TOO_LARGE", `The archive is ${archiveBytes} bytes; the limit is ${limits.maxArchiveBytes}.`);
  }
  const zip = await openZip(zipPath);
  try {
    if (zip.entryCount > limits.zipMaxEntries) {
      throw new ZipLimitError("ZIP_TOO_MANY_ENTRIES", `The archive declares ${zip.entryCount} entries; the limit is ${limits.zipMaxEntries}.`);
    }
    const entries: ScanEntry[] = [];
    const seen = new Set<string>();
    let totalDeclaredBytes = 0;
    let index = 0;
    for (let entry = await nextEntry(zip); entry; entry = await nextEntry(zip), index++) {
      const base = { index, rawName: entry.fileName, declaredBytes: entry.uncompressedSize, compressedBytes: entry.compressedSize };
      if (entry.fileName.endsWith("/") || entry.fileName.endsWith("\\")) {
        entries.push({ ...base, entryPath: null, folder: "", fileName: "", verdict: "directory" });
        continue;
      }

      const sanitized = sanitizeEntryPath(entry.fileName, limits);
      if (!sanitized.ok) {
        // a path that tries to escape marks the whole archive as hostile
        if (sanitized.code === "PATH_TRAVERSAL" || sanitized.code === "PATH_ABSOLUTE") {
          throw new ZipLimitError("ZIP_UNSAFE_PATH", `The archive contains an unsafe path and was refused: ${sanitized.message}`);
        }
        entries.push({ ...base, entryPath: null, folder: "", fileName: "", verdict: "reject", reject: { code: sanitized.code, message: sanitized.message } });
        continue;
      }
      const path = { ...base, entryPath: sanitized.path, folder: sanitized.folder, fileName: sanitized.fileName };

      if (isJunkEntry(sanitized.path)) {
        entries.push({ ...path, verdict: "ignore" });
        continue;
      }

      totalDeclaredBytes += entry.uncompressedSize;
      if (totalDeclaredBytes > limits.zipMaxTotalBytes) {
        throw new ZipLimitError("ZIP_TOTAL_TOO_LARGE", `The archive would inflate to more than ${limits.zipMaxTotalBytes} bytes.`);
      }
      if (entry.uncompressedSize > MIN_RATIO_CHECK_BYTES && (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > limits.zipMaxRatio)) {
        throw new ZipLimitError("ZIP_RATIO_EXCEEDED", `"${sanitized.path}" inflates more than ${limits.zipMaxRatio}:1 - this looks like a ZIP bomb and the archive was refused.`);
      }

      const reject = (code: EntryRejectionCode, message: string) => entries.push({ ...path, verdict: "reject", reject: { code, message } });
      const key = sanitized.path.toLowerCase();
      if (isSymlink(entry)) reject("SYMLINK_NOT_ALLOWED", "Symbolic links are not extracted.");
      else if (entry.isEncrypted()) reject("ENCRYPTED", "Encrypted entries cannot be read.");
      else if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) reject("UNSUPPORTED_COMPRESSION", `Compression method ${entry.compressionMethod} is not supported.`);
      else if (seen.has(key)) reject("DUPLICATE_PATH", "Another entry in the archive has the same path.");
      else {
        seen.add(key);
        const type = fileTypeFor(sanitized.fileName);
        if (!type) reject("UNSUPPORTED_TYPE", `"${sanitized.fileName}" is not a supported file type.`);
        else if (type.kind === "ARCHIVE") reject("NESTED_ARCHIVE", "Archives inside archives are not extracted.");
        else if (entry.uncompressedSize > limits.maxFileBytes) reject("FILE_TOO_LARGE", `The file is larger than the ${limits.maxFileBytes}-byte limit.`);
        else entries.push({ ...path, verdict: "extract" });
      }
    }
    if (totalDeclaredBytes > MIN_RATIO_CHECK_BYTES && totalDeclaredBytes / Math.max(1, archiveBytes) > limits.zipMaxRatio) {
      throw new ZipLimitError("ZIP_RATIO_EXCEEDED", `The archive inflates more than ${limits.zipMaxRatio}:1 overall - this looks like a ZIP bomb and it was refused.`);
    }
    return {
      archiveBytes,
      entryCount: zip.entryCount,
      entries,
      extractable: entries.filter((e) => e.verdict === "extract").length,
      rejected: entries.filter((e) => e.verdict === "reject").length,
      ignored: entries.filter((e) => e.verdict === "ignore").length,
      totalDeclaredBytes,
    };
  } finally {
    zip.close();
  }
}

export interface ExtractedFile {
  entry: ScanEntry;
  entryPath: string;
  folder: string;
  fileName: string;
  /** A server-named temporary file. It is deleted as soon as the handler returns - move or store it inside the handler. */
  tempPath: string;
  sizeBytes: number;
  sha256: string;
  /** The first bytes of the file, for signature validation. */
  head: Buffer;
}

export interface ExtractHandlers {
  /** Called once per extracted file, sequentially, so at most one extracted file exists on disk at a time. */
  onFile(file: ExtractedFile): Promise<void>;
  /** Called for entries that were rejected or ignored in the scan (nothing was extracted). */
  onSkipped?(entry: ScanEntry): Promise<void> | void;
  /** Return true to skip an entry whose result is already persisted (a restarted job continues instead of repeating work). */
  alreadyDone?(entry: ScanEntry): Promise<boolean> | boolean;
  signal?: AbortSignal;
}

/** Counts, hashes and bounds the bytes that actually leave the inflater. */
class GuardTransform extends Transform {
  count = 0;
  private readonly hash = createHash("sha256");
  private readonly head: Buffer[] = [];
  private headLength = 0;

  constructor(
    private readonly name: string,
    private readonly maxBytes: number,
    private readonly compressedBytes: number,
    private readonly maxRatio: number,
    private readonly addToTotal: (delta: number) => void,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.count += chunk.length;
    if (this.count > this.maxBytes) {
      callback(new ZipLimitError("ZIP_BOMB_DETECTED", `"${this.name}" inflated past ${this.maxBytes} bytes: the archive's own size information is wrong.`));
      return;
    }
    if (this.count > MIN_RATIO_CHECK_BYTES && this.count / Math.max(1, this.compressedBytes) > this.maxRatio) {
      callback(new ZipLimitError("ZIP_BOMB_DETECTED", `"${this.name}" inflates more than ${this.maxRatio}:1 - extraction was stopped.`));
      return;
    }
    try {
      this.addToTotal(chunk.length);
    } catch (err) {
      callback(err as Error);
      return;
    }
    this.hash.update(chunk);
    if (this.headLength < HEAD_BYTES) {
      const take = chunk.subarray(0, HEAD_BYTES - this.headLength);
      this.head.push(Buffer.from(take));
      this.headLength += take.length;
    }
    callback(null, chunk);
  }

  digest(): { sha256: string; head: Buffer } {
    return { sha256: this.hash.digest("hex"), head: Buffer.concat(this.head).subarray(0, HEAD_BYTES) };
  }
}

/**
 * Second pass: extracts the entries the scan marked `extract`, one at a time, streaming each to a server-named temp file
 * while counting the real inflated bytes. The archive's own size claims are never trusted: a lying header, an
 * over-budget total or an implausible ratio stops extraction immediately with a ZipLimitError.
 */
export async function extractZip(zipPath: string, workDir: string, limits: MediaLimits, scan: ZipScan, handlers: ExtractHandlers): Promise<{ extracted: number; resumed: number; skipped: number }> {
  const zip = await openZip(zipPath);
  let extracted = 0;
  let resumed = 0;
  let skipped = 0;
  let totalInflated = 0;
  const addToTotal = (delta: number) => {
    totalInflated += delta;
    if (totalInflated > limits.zipMaxTotalBytes) {
      throw new ZipLimitError("ZIP_BOMB_DETECTED", `Extraction passed the ${limits.zipMaxTotalBytes}-byte total limit and was stopped.`);
    }
  };

  try {
    for (let entry = await nextEntry(zip), index = 0; entry; entry = await nextEntry(zip), index++) {
      if (handlers.signal?.aborted) throw new ZipLimitError("ZIP_ABORTED", "Extraction was cancelled.");
      const planned = scan.entries[index];
      if (!planned || planned.rawName !== entry.fileName) {
        throw new ZipLimitError("ZIP_INVALID", "The archive changed between the scan and the extraction.");
      }
      if (planned.verdict === "directory" || planned.verdict === "ignore") continue; // folders and archiver junk: nothing to report
      if (planned.verdict !== "extract" || planned.entryPath === null) {
        skipped++;
        await handlers.onSkipped?.(planned);
        continue;
      }
      if (await handlers.alreadyDone?.(planned)) {
        resumed++;
        continue;
      }

      const tempPath = join(workDir, `entry-${index}.part`);
      const guard = new GuardTransform(planned.entryPath, Math.min(planned.declaredBytes, limits.maxFileBytes), planned.compressedBytes, limits.zipMaxRatio, addToTotal);
      try {
        const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
          zip.openReadStream(entry!, (err, s) => (err || !s ? reject(new ZipLimitError("ZIP_INVALID", `"${planned.entryPath}" could not be read (${err?.message ?? "no stream"}).`)) : resolve(s)));
        });
        await pipeline(stream, guard, createWriteStream(tempPath));
        const { sha256, head } = guard.digest();
        await handlers.onFile({ entry: planned, entryPath: planned.entryPath, folder: planned.folder, fileName: planned.fileName, tempPath, sizeBytes: guard.count, sha256, head });
        extracted++;
      } catch (err) {
        if (err instanceof ZipLimitError) throw err;
        // yauzl reports a size mismatch as a plain error: that is a lying header
        if (err instanceof Error && /too (many|few) bytes/i.test(err.message)) throw new ZipLimitError("ZIP_BOMB_DETECTED", `"${planned.entryPath}" does not match its declared size: ${err.message}`);
        throw err;
      } finally {
        await unlink(tempPath).catch(() => undefined);
      }
    }
    return { extracted, resumed, skipped };
  } finally {
    zip.close();
  }
}
