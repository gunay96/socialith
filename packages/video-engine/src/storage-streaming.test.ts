import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalAssetStorage, R2AssetStorage, StorageKeyExistsError } from "./storage.js";
import { S3Client } from "@aws-sdk/client-s3";

const readAll = async (stream: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
};

describe("LocalAssetStorage streaming", () => {
  let base: string;
  let src: string;
  let storage: LocalAssetStorage;
  const content = Buffer.from("0123456789".repeat(1000)); // 10,000 bytes
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "ve-storage-"));
    src = join(mkdtempSync(join(tmpdir(), "ve-src-")), "source.bin");
    writeFileSync(src, content);
    storage = new LocalAssetStorage({ baseDir: base, baseUrl: "http://localhost:4000/media" });
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("streams a file in and back out unchanged", async () => {
    const stored = await storage.putFile("org1/a/original.bin", src);
    expect(stored.key).toBe("org1/a/original.bin");
    const out = await storage.createReadStream("org1/a/original.bin");
    expect(out.sizeBytes).toBe(content.length);
    expect((await readAll(out.stream)).equals(content)).toBe(true);
  });

  it("serves a byte range, as a video player's Range request needs", async () => {
    const r = await storage.createReadStream("org1/a/original.bin", { start: 100, end: 199 });
    expect(r.range).toEqual({ start: 100, end: 199 });
    expect(r.sizeBytes).toBe(content.length);
    expect((await readAll(r.stream)).equals(content.subarray(100, 200))).toBe(true);
    const open = await storage.createReadStream("org1/a/original.bin", { start: 9990 });
    expect((await readAll(open.stream)).length).toBe(10);
  });

  it("rejects an unsatisfiable range", async () => {
    await expect(storage.createReadStream("org1/a/original.bin", { start: 20_000 })).rejects.toThrow(RangeError);
  });

  it("NEVER overwrites an existing object unless explicitly told to (originals are immutable)", async () => {
    const other = join(mkdtempSync(join(tmpdir(), "ve-src2-")), "other.bin");
    writeFileSync(other, "different bytes");
    await expect(storage.putFile("org1/a/original.bin", other)).rejects.toBeInstanceOf(StorageKeyExistsError);
    expect(readFileSync(join(base, "org1/a/original.bin")).equals(content)).toBe(true); // untouched
    await storage.putFile("org1/a/derivative.bin", other);
    await storage.putFile("org1/a/derivative.bin", src, { overwrite: true });
    expect(readFileSync(join(base, "org1/a/derivative.bin")).equals(content)).toBe(true);
  });

  it("leaves no partial file behind when the source cannot be read", async () => {
    await expect(storage.putFile("org1/b/never.bin", join(base, "does-not-exist"))).rejects.toThrow();
    const files = await readdir(join(base, "org1/b")).catch(() => [] as string[]);
    expect(files).toEqual([]);
    expect(await storage.exists("org1/b/never.bin")).toBe(false);
  });

  it("downloads to a file", async () => {
    const dest = join(base, "downloads/copy.bin");
    await storage.downloadToFile("org1/a/original.bin", dest);
    expect(readFileSync(dest).equals(content)).toBe(true);
  });

  it.each(["../escape", "a/../../escape", "/absolute", "\\absolute", "C:\\x", "a\0b", ""])("refuses an unsafe key: %j", async (key) => {
    await expect(storage.putFile(key, src)).rejects.toThrow(/Unsafe storage key/);
    await expect(storage.createReadStream(key)).rejects.toThrow(/Unsafe storage key/);
  });

  it("keeps the old buffer API working for existing callers", async () => {
    const r = await storage.upload("legacy/x.bin", Buffer.from("legacy"));
    expect(r.url).toBe("http://localhost:4000/media/legacy/x.bin");
    expect(await storage.exists("legacy/x.bin")).toBe(true);
    await storage.delete("legacy/x.bin");
    expect(await storage.exists("legacy/x.bin")).toBe(false);
  });
});

/**
 * The REAL S3Client (and the real streaming uploader) talking to an in-process S3: the request handler answers the
 * minimal S3 protocol from a Map, so nothing is faked about how requests are built, signed or parsed.
 */
function inProcessS3(objects: Map<string, Buffer>) {
  const calls: { method: string; path: string; headers: Record<string, string> }[] = [];
  const requestHandler = {
    metadata: { handlerProtocol: "http/1.1" },
    destroy: () => undefined,
    async handle(request: { method: string; path: string; headers: Record<string, string>; body?: unknown }) {
      calls.push({ method: request.method, path: request.path, headers: request.headers });
      const key = decodeURIComponent(request.path.replace(/^\//, ""));
      const respond = (statusCode: number, headers: Record<string, string> = {}, body?: Readable) => ({ response: { statusCode, headers, body: body ?? Readable.from([]) } });
      if (request.method === "PUT") {
        const body = request.body;
        const data = body instanceof Readable ? await readAll(body) : Buffer.from((body as Uint8Array | string | undefined) ?? "");
        objects.set(key, data);
        return respond(200, { etag: '"etag"' });
      }
      const data = objects.get(key);
      if (request.method === "HEAD") return data ? respond(200, { "content-length": String(data.length), "content-type": "application/octet-stream" }) : respond(404);
      if (request.method === "DELETE") {
        objects.delete(key);
        return respond(204);
      }
      if (request.method === "GET") {
        if (!data) return respond(404, { "content-type": "application/xml" }, Readable.from(["<Error><Code>NoSuchKey</Code></Error>"]));
        const range = request.headers.range ? /bytes=(\d+)-(\d*)/.exec(request.headers.range) : null;
        if (!range) return respond(200, { "content-length": String(data.length), "content-type": "video/mp4" }, Readable.from([data]));
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : data.length - 1;
        return respond(206, { "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${data.length}`, "content-type": "video/mp4" }, Readable.from([data.subarray(start, end + 1)]));
      }
      return respond(405);
    },
  };
  const client = new S3Client({
    region: "auto",
    endpoint: "http://s3.test",
    forcePathStyle: true,
    credentials: { accessKeyId: "k", secretAccessKey: "s" },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler,
  });
  return { client, calls };
}
describe("R2AssetStorage (S3-compatible) streaming, against a stand-in S3 client", () => {
  const config = { accountId: "acct", accessKeyId: "k", secretAccessKey: "s", bucketName: "library" };
  let src: string;
  const content = Buffer.from("abcdefghij".repeat(500));
  beforeAll(() => {
    src = join(mkdtempSync(join(tmpdir(), "ve-r2-")), "o.bin");
    writeFileSync(src, content);
  });

  it("streams a file up with the right bucket, key and content type, then reads it back (and a range)", async () => {
    const objects = new Map<string, Buffer>();
    const { client, calls } = inProcessS3(objects);
    const r2 = new R2AssetStorage({ ...config, publicUrl: "https://cdn.example.com" }, client);
    const stored = await r2.putFile("lib/o.bin", src, { contentType: "video/mp4" });
    expect(stored).toEqual({ key: "lib/o.bin", url: "https://cdn.example.com/lib/o.bin" });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("/library/lib/o.bin"); // bucket + key, path-style
    expect(put.headers["content-type"]).toBe("video/mp4");
    expect(objects.get("library/lib/o.bin")!.equals(content)).toBe(true);

    const whole = await r2.createReadStream("lib/o.bin");
    expect((await readAll(whole.stream)).equals(content)).toBe(true);
    const part = await r2.createReadStream("lib/o.bin", { start: 10, end: 19 });
    expect(part.range).toEqual({ start: 10, end: 19 });
    expect(part.sizeBytes).toBe(content.length);
    expect((await readAll(part.stream)).equals(content.subarray(10, 20))).toBe(true);
  });

  it("refuses to overwrite an existing original", async () => {
    const objects = new Map([["library/lib/o.bin", Buffer.from("original")]]);
    const { client } = inProcessS3(objects);
    await expect(new R2AssetStorage(config, client).putFile("lib/o.bin", src)).rejects.toBeInstanceOf(StorageKeyExistsError);
    expect(objects.get("library/lib/o.bin")!.toString()).toBe("original");
  });

  it("refuses unsafe keys before sending anything", async () => {
    const { client, calls } = inProcessS3(new Map());
    const r2 = new R2AssetStorage(config, client);
    await expect(r2.putFile("../x", src)).rejects.toThrow(/Unsafe storage key/);
    expect(calls).toEqual([]);
  });

  it("downloads to a file", async () => {
    const objects = new Map([["library/lib/o.bin", content]]);
    const { client } = inProcessS3(objects);
    const dest = join(mkdtempSync(join(tmpdir(), "ve-r2-dl-")), "copy.bin");
    await new R2AssetStorage(config, client).downloadToFile("lib/o.bin", dest);
    expect(readFileSync(dest).equals(content)).toBe(true);
  });

  it("is configured for R2's own endpoint by default, or for any S3-compatible endpoint with path-style addressing", async () => {
    const withDefault = new R2AssetStorage(config) as unknown as { client: S3Client };
    expect(String(await withDefault.client.config.endpoint?.().then((e) => `${e.protocol}//${e.hostname}`))).toBe("https://acct.r2.cloudflarestorage.com");
    const custom = new R2AssetStorage({ ...config, endpoint: "http://127.0.0.1:9000" }) as unknown as { client: S3Client };
    const e = await custom.client.config.endpoint?.();
    expect(`${e?.protocol}//${e?.hostname}:${e?.port}`).toBe("http://127.0.0.1:9000");
    expect(custom.client.config.forcePathStyle).toBe(true);
  });
});
