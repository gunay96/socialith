import { describe, expect, it } from "vitest";
import { isJunkEntry, sanitizeEntryPath } from "./path.js";

const limits = { zipMaxPathLength: 60, zipMaxDepth: 4 };
const ok = (raw: string) => {
  const r = sanitizeEntryPath(raw, limits);
  if (!r.ok) throw new Error(`expected ok for ${raw}: ${r.message}`);
  return r;
};
const bad = (raw: string) => {
  const r = sanitizeEntryPath(raw, limits);
  if (r.ok) throw new Error(`expected a rejection for ${raw}, got ${r.path}`);
  return r.code;
};

describe("sanitizeEntryPath", () => {
  it("keeps a normal folder structure as a relative forward-slash path", () => {
    expect(ok("campaign/videos/clip 01.mp4")).toEqual({ ok: true, path: "campaign/videos/clip 01.mp4", folder: "campaign/videos", fileName: "clip 01.mp4" });
    expect(ok("top.png")).toMatchObject({ folder: "", fileName: "top.png" });
  });

  it("normalizes './', empty segments and backslashes", () => {
    expect(ok("./a//b/./c.png").path).toBe("a/b/c.png");
    expect(ok("a\\b\\c.png").path).toBe("a/b/c.png");
  });

  it.each(["../evil.png", "a/../../evil.png", "a/b/../../../evil.png", "..\\evil.png", "a\\..\\..\\evil.png", "a/..", ".."])("rejects traversal: %s", (raw) => {
    expect(bad(raw)).toBe("PATH_TRAVERSAL");
  });

  it.each(["/etc/passwd", "\\windows\\system32\\x.dll", "C:\\Windows\\x.png", "c:/x.png", "//server/share/x.png", "\\\\server\\share\\x.png"])("rejects absolute and drive paths: %s", (raw) => {
    expect(bad(raw)).toBe("PATH_ABSOLUTE");
  });

  it("rejects NUL bytes, control characters and empty names", () => {
    expect(bad("a\0.png")).toBe("PATH_INVALID");
    expect(bad("a\n.png")).toBe("PATH_INVALID");
    expect(bad("a\u007f.png")).toBe("PATH_INVALID");
    expect(bad("")).toBe("PATH_INVALID");
    expect(bad("./")).toBe("PATH_INVALID");
  });

  it("enforces length and depth limits", () => {
    expect(bad(`${"x".repeat(61)}.png`)).toBe("PATH_TOO_LONG");
    expect(bad("a/b/c/d/e/f.png")).toBe("PATH_TOO_DEEP");
    expect(ok("a/b/c/d/f.png").path).toBe("a/b/c/d/f.png");
  });

  it("does not mistake names that merely contain dots for traversal", () => {
    expect(ok("a/..hidden/b..png").path).toBe("a/..hidden/b..png");
    expect(ok("v1.2.3/final...mp4").path).toBe("v1.2.3/final...mp4");
  });
});

describe("isJunkEntry", () => {
  it("recognises the files archivers add on their own", () => {
    expect(isJunkEntry("__MACOSX/a/._clip.mp4")).toBe(true);
    expect(isJunkEntry("a/.DS_Store")).toBe(true);
    expect(isJunkEntry("a/Thumbs.db")).toBe(true);
    expect(isJunkEntry("a/._clip.mp4")).toBe(true);
    expect(isJunkEntry("a/clip.mp4")).toBe(false);
  });
});
