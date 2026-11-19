import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAssetStorage, resolveAssetStorage, R2AssetStorage } from "./storage.js";

describe("LocalAssetStorage", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("writes real bytes to disk and returns a resolvable URL", async () => {
    dir = await mkdtemp(join(tmpdir(), "socialith-video-engine-test-"));
    const storage = new LocalAssetStorage({ baseDir: dir, baseUrl: "http://localhost:4000/media" });

    const result = await storage.upload("org1/content1/thumb.png", Buffer.from("fake-png-bytes"));

    expect(result.url).toBe("http://localhost:4000/media/org1/content1/thumb.png");
    const written = await readFile(join(dir, "org1/content1/thumb.png"));
    expect(written.toString()).toBe("fake-png-bytes");
  });

  it("creates nested directories that don't exist yet", async () => {
    dir = await mkdtemp(join(tmpdir(), "socialith-video-engine-test-"));
    const storage = new LocalAssetStorage({ baseDir: dir, baseUrl: "http://localhost:4000/media" });

    await storage.upload("deep/nested/path/file.bin", Buffer.from("x"));

    const written = await readFile(join(dir, "deep/nested/path/file.bin"));
    expect(written.toString()).toBe("x");
  });

  it("rejects a path-traversal key", async () => {
    const storage = new LocalAssetStorage({ baseDir: "/tmp/whatever", baseUrl: "http://x" });
    await expect(storage.upload("../../etc/passwd", Buffer.from("x"))).rejects.toThrow(/Unsafe storage key/);
  });

  it("reports exists()/getMetadata() honestly for a file that was never written", async () => {
    dir = await mkdtemp(join(tmpdir(), "socialith-video-engine-test-"));
    const storage = new LocalAssetStorage({ baseDir: dir, baseUrl: "http://localhost:4000/media" });

    expect(await storage.exists("nope.png")).toBe(false);
    expect(await storage.getMetadata("nope.png")).toBeNull();
  });

  it("round-trips exists()/getMetadata()/delete() for a real written file", async () => {
    dir = await mkdtemp(join(tmpdir(), "socialith-video-engine-test-"));
    const storage = new LocalAssetStorage({ baseDir: dir, baseUrl: "http://localhost:4000/media" });

    await storage.upload("real.png", Buffer.from("bytes"));
    expect(await storage.exists("real.png")).toBe(true);
    const meta = await storage.getMetadata("real.png");
    expect(meta?.sizeBytes).toBe(5);

    await storage.delete("real.png");
    expect(await storage.exists("real.png")).toBe(false);
  });
});

describe("resolveAssetStorage", () => {
  it("selects R2AssetStorage when r2 config is provided", () => {
    const storage = resolveAssetStorage({
      r2: { accountId: "acct", accessKeyId: "key", secretAccessKey: "secret", bucketName: "bucket" },
      local: { baseDir: "/tmp/x", baseUrl: "http://x" },
    });
    expect(storage).toBeInstanceOf(R2AssetStorage);
    expect(storage.kind).toBe("r2");
  });

  it("falls back to LocalAssetStorage when no r2 config is provided", () => {
    const storage = resolveAssetStorage({ local: { baseDir: "/tmp/x", baseUrl: "http://x" } });
    expect(storage).toBeInstanceOf(LocalAssetStorage);
    expect(storage.kind).toBe("local");
  });
});
