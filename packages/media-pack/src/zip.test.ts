import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withLimits } from "./limits.js";
import { buildZip, writeLargeStoredZip, type TestEntry } from "./testing/zip-builder.js";
import { extractZip, scanZip, ZipLimitError, type ExtractedFile, type ZipScan } from "./zip.js";
import type { MediaLimits } from "./limits.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mediapack-zip-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
let n = 0;
async function zipFile(entries: TestEntry[]): Promise<string> {
  const path = join(dir, `t${n++}.zip`);
  await writeFile(path, buildZip(entries));
  return path;
}
async function work(): Promise<string> {
  return mkdtemp(join(dir, "work-"));
}
async function collect(path: string, limits: MediaLimits = withLimits(), extra: Partial<Parameters<typeof extractZip>[4]> = {}) {
  const scan = await scanZip(path, limits);
  const files: (Omit<ExtractedFile, "entry"> & { content: Buffer })[] = [];
  const skipped: string[] = [];
  const w = await work();
  const result = await extractZip(path, w, limits, scan, {
    onFile: async (f) => {
      files.push({ entryPath: f.entryPath, folder: f.folder, fileName: f.fileName, tempPath: f.tempPath, sizeBytes: f.sizeBytes, sha256: f.sha256, head: f.head, content: await readFile(f.tempPath) });
    },
    onSkipped: (e) => void skipped.push(`${e.rawName}:${e.reject?.code ?? e.verdict}`),
    ...extra,
  });
  return { scan, files, skipped, result, w };
}
const scanError = async (path: string, limits = withLimits()): Promise<ZipLimitError> => {
  try {
    await scanZip(path, limits);
  } catch (err) {
    if (err instanceof ZipLimitError) return err;
    throw err;
  }
  throw new Error("expected scanZip to refuse the archive");
};

describe("ZIP extraction", () => {
  it("extracts files, preserves the folder structure as metadata, hashes and measures each file", async () => {
    const a = Buffer.from("hello text file\n");
    const path = await zipFile([
      { name: "campaign/", data: Buffer.alloc(0) },
      { name: "campaign/images/cover.png", data: PNG, method: 8 },
      { name: "campaign/notes/readme.txt", data: a },
      { name: "root.png", data: PNG },
    ]);
    const { files, scan, result } = await collect(path);
    expect(scan.extractable).toBe(3);
    expect(result).toMatchObject({ extracted: 3, resumed: 0, skipped: 0 });
    const byPath = Object.fromEntries(files.map((f) => [f.entryPath, f]));
    expect(byPath["campaign/images/cover.png"]).toMatchObject({ folder: "campaign/images", fileName: "cover.png", sizeBytes: PNG.length, sha256: sha(PNG) });
    expect(byPath["campaign/images/cover.png"]!.content.equals(PNG)).toBe(true);
    expect(byPath["campaign/images/cover.png"]!.head.subarray(0, 4).equals(PNG.subarray(0, 4))).toBe(true);
    expect(byPath["campaign/notes/readme.txt"]).toMatchObject({ folder: "campaign/notes", sha256: sha(a) });
    expect(byPath["root.png"]).toMatchObject({ folder: "" });
  });

  it("writes only server-named temp files, deletes each one after its handler, and holds at most one at a time", async () => {
    const path = await zipFile([
      { name: "a/one.png", data: PNG },
      { name: "a/two.png", data: Buffer.concat([PNG, Buffer.from("2")]) },
      { name: "a/three.png", data: Buffer.concat([PNG, Buffer.from("3")]) },
    ]);
    const w = await work();
    const scan = await scanZip(path, withLimits());
    const seen: number[] = [];
    await extractZip(path, w, withLimits(), scan, {
      onFile: async (f) => {
        const present = await readdir(w);
        seen.push(present.length);
        expect(present).toEqual([`entry-${f.entry.index}.part`]); // no name derived from the archive
      },
    });
    expect(seen).toEqual([1, 1, 1]);
    expect(await readdir(w)).toEqual([]);
  });

  it("skips macOS/Windows junk silently and reports rejected entries without extracting them", async () => {
    const path = await zipFile([
      { name: "__MACOSX/._cover.png", data: Buffer.from("x") },
      { name: ".DS_Store", data: Buffer.from("x") },
      { name: "cover.png", data: PNG },
      { name: "inner.zip", data: Buffer.from("PK\x03\x04") },
      { name: "payload.exe", data: Buffer.from("MZ") },
      { name: "COVER.PNG", data: PNG }, // same path, other case
    ]);
    const { files, skipped, scan } = await collect(path);
    expect(files.map((f) => f.entryPath)).toEqual(["cover.png"]);
    expect(scan.ignored).toBe(2);
    expect(skipped).toEqual(expect.arrayContaining(["inner.zip:NESTED_ARCHIVE", "payload.exe:UNSUPPORTED_TYPE", "COVER.PNG:DUPLICATE_PATH"]));
    expect(skipped.some((s) => s.includes("DS_Store") || s.includes("MACOSX"))).toBe(false);
  });

  it("rejects symbolic links, encrypted entries and over-long or over-deep paths per entry, keeping the rest", async () => {
    const path = await zipFile([
      { name: "link.png", data: Buffer.from("target"), unixMode: 0o120777 },
      { name: "secret.png", data: PNG, flags: 1 },
      { name: `${"x".repeat(300)}.png`, data: PNG },
      { name: "a/b/c/d/e/f/g/h/i/j/k/l/m/n.png", data: PNG },
      { name: "fine.png", data: PNG },
    ]);
    const { files, skipped } = await collect(path);
    expect(files.map((f) => f.entryPath)).toEqual(["fine.png"]);
    expect(skipped.sort()).toEqual(["link.png:SYMLINK_NOT_ALLOWED", `${"x".repeat(300)}.png:PATH_TOO_LONG`, "a/b/c/d/e/f/g/h/i/j/k/l/m/n.png:PATH_TOO_DEEP", "secret.png:ENCRYPTED"].sort());
  });

  it("rejects a single file larger than the per-file limit but extracts the others", async () => {
    const path = await zipFile([
      { name: "big.png", data: Buffer.concat([PNG, Buffer.alloc(5000, 1)]) },
      { name: "small.png", data: PNG },
    ]);
    const { files, skipped } = await collect(path, withLimits({ maxFileBytes: 1000 }));
    expect(files.map((f) => f.entryPath)).toEqual(["small.png"]);
    expect(skipped).toEqual(["big.png:FILE_TOO_LARGE"]);
  });
});

describe("ZIP traversal protection", () => {
  it.each([
    "../evil.png",
    "a/../../evil.png",
    "..\\evil.png",
    "/etc/cron.d/evil.png",
    "C:\\Windows\\evil.png",
    "\\\\server\\share\\evil.png",
  ])("refuses the whole archive when it contains %s, and extracts nothing", async (name) => {
    const path = await zipFile([
      { name: "innocent.png", data: PNG },
      { name, data: PNG },
    ]);
    const err = await scanError(path);
    expect(err.code).toBe("ZIP_UNSAFE_PATH");
  });
});

describe("ZIP bomb limits", () => {
  it("refuses an archive that declares more entries than allowed", async () => {
    const entries: TestEntry[] = Array.from({ length: 2100 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from("x") }));
    const err = await scanError(await zipFile(entries));
    expect(err.code).toBe("ZIP_TOO_MANY_ENTRIES");
    // and a custom lower limit is honoured
    const small = await zipFile([{ name: "a.txt", data: Buffer.from("a") }, { name: "b.txt", data: Buffer.from("b") }, { name: "c.txt", data: Buffer.from("c") }]);
    expect((await scanError(small, withLimits({ zipMaxEntries: 2 }))).code).toBe("ZIP_TOO_MANY_ENTRIES");
  });

  it("refuses a classic compression bomb by ratio before extracting anything", async () => {
    const bomb = Buffer.alloc(20 * 1024 * 1024); // 20 MB of zeros deflates to ~20 KB (ratio > 1000)
    const err = await scanError(await zipFile([{ name: "zeros.txt", data: bomb, method: 8 }]));
    expect(err.code).toBe("ZIP_RATIO_EXCEEDED");
  });

  it("refuses an archive whose total inflated size exceeds the limit", async () => {
    const path = await zipFile([
      { name: "a.txt", data: Buffer.alloc(600, 1) },
      { name: "b.txt", data: Buffer.alloc(600, 2) },
    ]);
    expect((await scanError(path, withLimits({ zipMaxTotalBytes: 1000 }))).code).toBe("ZIP_TOTAL_TOO_LARGE");
  });

  it("refuses an uploaded archive larger than the archive limit", async () => {
    const path = await zipFile([{ name: "a.txt", data: Buffer.alloc(4000, 1) }]);
    expect((await scanError(path, withLimits({ maxArchiveBytes: 1000 }))).code).toBe("ZIP_ARCHIVE_TOO_LARGE");
  });

  it("refuses a file that is not a ZIP at all", async () => {
    const path = join(dir, "not-a-zip.zip");
    await writeFile(path, Buffer.from("this is plainly not an archive"));
    expect((await scanError(path)).code).toBe("ZIP_INVALID");
  });

  it("stops at once when an entry inflates past what its header declared (a lying size)", async () => {
    // declares 1,000 bytes, really inflates to 5 MB
    const path = await zipFile([{ name: "liar.txt", data: Buffer.alloc(5 * 1024 * 1024), method: 8, declaredSize: 1000 }]);
    const scan = await scanZip(path, withLimits()); // the declared numbers look harmless
    expect(scan.extractable).toBe(1);
    const w = await work();
    await expect(extractZip(path, w, withLimits(), scan, { onFile: async () => undefined })).rejects.toMatchObject({ code: "ZIP_BOMB_DETECTED" });
    expect(await readdir(w)).toEqual([]); // nothing left behind
  });

  it("enforces the total budget on the bytes actually inflated, not on the declared ones", async () => {
    const path = await zipFile([
      { name: "a.txt", data: Buffer.alloc(900, 1) },
      { name: "b.txt", data: Buffer.alloc(900, 2) },
    ]);
    const scan = await scanZip(path, withLimits());
    const tight = withLimits({ zipMaxTotalBytes: 1200 });
    await expect(extractZip(path, await work(), tight, scan, { onFile: async () => undefined })).rejects.toMatchObject({ code: "ZIP_BOMB_DETECTED" });
  });
});

describe("resumable, cancellable and memory-safe extraction", () => {
  it("skips entries whose result is already persisted (a restarted job continues instead of repeating)", async () => {
    const path = await zipFile([
      { name: "a.png", data: PNG },
      { name: "b.png", data: Buffer.concat([PNG, Buffer.from("b")]) },
      { name: "c.png", data: Buffer.concat([PNG, Buffer.from("c")]) },
    ]);
    const done = new Set(["a.png", "b.png"]);
    const { files, result } = await collect(path, withLimits(), { alreadyDone: (e) => done.has(e.entryPath ?? "") });
    expect(files.map((f) => f.entryPath)).toEqual(["c.png"]);
    expect(result).toMatchObject({ extracted: 1, resumed: 2 });
  });

  it("stops between entries when cancelled", async () => {
    const path = await zipFile([
      { name: "a.png", data: PNG },
      { name: "b.png", data: PNG },
    ]);
    const controller = new AbortController();
    const scan = await scanZip(path, withLimits());
    const seen: string[] = [];
    await expect(
      extractZip(path, await work(), withLimits(), scan, {
        signal: controller.signal,
        onFile: async (f) => {
          seen.push(f.entryPath);
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: "ZIP_ABORTED" });
    expect(seen).toEqual(["a.png"]);
  });

  it("a handler failure propagates and still removes the temp file", async () => {
    const path = await zipFile([{ name: "a.png", data: PNG }]);
    const w = await work();
    const scan = await scanZip(path, withLimits());
    await expect(extractZip(path, w, withLimits(), scan, { onFile: async () => Promise.reject(new Error("storage down")) })).rejects.toThrow("storage down");
    expect(await readdir(w)).toEqual([]);
  });

  it("streams a 160 MB entry without holding it in memory", async () => {
    const size = 160 * 1024 * 1024;
    const path = join(dir, "large.zip");
    await writeLargeStoredZip(path, "videos/large.mp4", size);
    const limits = withLimits();
    const scan = await scanZip(path, limits);
    expect(scan.entries[0]).toMatchObject({ entryPath: "videos/large.mp4", verdict: "extract" });
    let peak = 0;
    const baseline = process.memoryUsage().arrayBuffers;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers - baseline);
    }, 5);
    let size2 = 0;
    await extractZip(path, await work(), limits, scan, {
      onFile: async (f) => {
        size2 = f.sizeBytes;
      },
    });
    clearInterval(timer);
    expect(size2).toBe(size);
    expect(peak).toBeLessThan(40 * 1024 * 1024); // a 160 MB entry never sits in memory (chunks are 64 KB)
  }, 120_000);
});

describe("scan result shape", () => {
  it("reports totals and per-entry verdicts", async () => {
    const path = await zipFile([
      { name: "d/", data: Buffer.alloc(0) },
      { name: "d/a.png", data: PNG },
      { name: "d/.DS_Store", data: Buffer.from("x") },
      { name: "d/evil.exe", data: Buffer.from("x") },
    ]);
    const scan: ZipScan = await scanZip(path, withLimits());
    expect(scan.entryCount).toBe(4);
    expect(scan).toMatchObject({ extractable: 1, rejected: 1, ignored: 1 });
    expect(scan.entries.map((e) => e.verdict)).toEqual(["directory", "extract", "ignore", "reject"]);
  });
});
