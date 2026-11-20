import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@socialith/auth";
import { prisma } from "@socialith/database";
import { QUEUE_NAMES, mediaProcessingJobId } from "@socialith/types";
import { createApp } from "../app.js";
import { libraryStorage } from "../services/media-common.js";

/**
 * Media library (Phase 5A) through the REAL express app against REAL MySQL + Redis/BullMQ. The API accepts, validates,
 * stores and queues; the worker's processing of ZIPs and media is covered by the worker integration tests.
 */
const enabled = Boolean(process.env.MYSQL_INTEGRATION_URL && process.env.REDIS_INTEGRATION_URL);
const suite = enabled ? describe : describe.skip;
const PASSWORD = "Correct-Horse-Battery-1";

let server: Server;
let base = "";
let redis: Redis;
let mediaQueue: Queue;
let scratch: string;

interface Envelope<T> { success?: boolean; data: T; error?: { code: string; message: string; details?: { code?: string; packId?: string; hint?: string } } }
async function http<T = unknown>(method: string, path: string, opts: { cookie?: string; body?: unknown; headers?: Record<string, string>; form?: FormData } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(opts.cookie ? { Cookie: opts.cookie } : {}), ...(opts.headers ?? {}) },
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  let json = {} as Envelope<T>;
  try {
    json = JSON.parse(text) as Envelope<T>;
  } catch {
    /* not JSON (a file) */
  }
  return { status: res.status, json, text, headers: res.headers };
}

type Role = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER";
interface Session { cookie: string; orgId: string; userId: string }
async function addUser(orgId: string, role: Role): Promise<Session> {
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@it-media.test`;
  const user = await prisma.user.create({ data: { organizationId: orgId, name: role, email, passwordHash: await hashPassword(PASSWORD), role, status: "ACTIVE" } });
  const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  expect(res.status).toBe(200);
  return { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]!, orgId, userId: user.id };
}
async function makeOrg(role: Role = "EDITOR"): Promise<Session> {
  const org = await prisma.organization.create({ data: { name: "IT media", slug: `it-medapi-${randomUUID().slice(0, 8)}` } });
  return addUser(org.id, role);
}

// -------- minimal files with the right signatures (the API validates signatures, it does not decode media)
const PNG = (extra = 0) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1), Buffer.alloc(extra, 9)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(200, 3)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]), Buffer.alloc(200, 5)]);
const TEXT = Buffer.from("Line one\nLine two\n");

async function upload(s: Session, name: string, data: Buffer, opts: { mime?: string; fields?: Record<string, string> } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(opts.fields ?? {})) form.append(k, v);
  form.append("file", new Blob([data], { type: opts.mime ?? "application/octet-stream" }), name);
  return http<{ duplicate: boolean; pack?: PackDto; asset?: AssetDto; task?: TaskDto }>("POST", "/api/media/uploads", { cookie: s.cookie, form });
}

interface AssetDto {
  id: string; packId: string | null; originalName: string; kind: string; status: string; sizeBytes: number; sha256: string; tags: string[];
  duplicateOf: { id: string } | null; rights: { status: string; confirmedAt: string | null }; contentUrl: string | null; thumbnailUrl: string | null; downloadOnly: boolean;
  facts: { width: number | null; durationMs: number | null; aspectRatio: string | null; measured: boolean };
  campaigns?: { id: string }[]; pageGroups?: { id: string }[]; inheritedFromPack?: { campaigns: { id: string }[]; pageGroups: { id: string }[] };
}
interface PackDto { id: string; name: string; status: string; sourceFileName: string | null; counts: Record<string, number>; campaigns: { id: string }[]; pageGroups: { id: string }[]; refused?: { path: string; code: string }[] }
interface TaskDto { id: string; type: string; status: string; stage: string | null; progress: { mode: string; percentage: number | null; completedUnits: number; totalUnits: number | null; stalled: boolean; elapsedMs: number | null } }
interface Paged<T> { items: T[]; total: number; page: number; pageSize: number }

const get = <T,>(s: Session, path: string, headers?: Record<string, string>) => http<T>("GET", path, { cookie: s.cookie, headers });
const put = <T = unknown,>(s: Session, path: string, body: unknown) => http<T>("PUT", path, { cookie: s.cookie, body });
const post = <T = unknown,>(s: Session, path: string, body?: unknown) => http<T>("POST", path, { cookie: s.cookie, body: body ?? {} });
const audit = (orgId: string, action: string) => prisma.auditLog.findMany({ where: { organizationId: orgId, action } });

function useServer() {
  beforeAll(async () => {
    const app = createApp(null);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });
}

beforeAll(async () => {
  if (!enabled) return;
  scratch = mkdtempSync(join(tmpdir(), "it-media-api-"));
  redis = new Redis(process.env.REDIS_INTEGRATION_URL!, { maxRetriesPerRequest: null });
  mediaQueue = new Queue(QUEUE_NAMES.MEDIA_PROCESSING, { connection: redis });
});
afterAll(async () => {
  if (!enabled) return;
  await mediaQueue.obliterate({ force: true }).catch(() => undefined);
  await mediaQueue.close();
  redis.disconnect();
  await prisma.organization.deleteMany({ where: { slug: { startsWith: "it-medapi-" } } });
  rmSync(scratch, { recursive: true, force: true });
  await prisma.$disconnect();
});

/** Creates a READY asset the way the worker leaves it (with a stored original and optional thumbnail). */
async function seedAsset(orgId: string, over: Partial<{ name: string; kind: "VIDEO" | "IMAGE" | "AUDIO" | "TEXT" | "SPREADSHEET"; status: "READY" | "ANALYZING" | "FAILED" | "REJECTED" | "DUPLICATE" | "ARCHIVED"; packId: string; folder: string; width: number; height: number; aspect: string; aspectDecimal: number; durationMs: number; hasAudio: boolean; tags: string[]; bytes: Buffer; mime: string; thumbnail: boolean }> = {}) {
  const bytes = over.bytes ?? PNG(Math.floor(Math.random() * 1000));
  const asset = await prisma.mediaAsset.create({
    data: {
      organizationId: orgId, packId: over.packId ?? null, folderPath: over.folder ?? "", originalName: over.name ?? `file-${randomUUID().slice(0, 6)}.png`, entryPath: over.packId ? `${over.folder ? over.folder + "/" : ""}${over.name ?? randomUUID()}` : null,
      kind: over.kind ?? "IMAGE", status: over.status ?? "READY", mimeType: over.mime ?? "image/png", sizeBytes: BigInt(bytes.length), sha256: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
      width: over.width ?? null, height: over.height ?? null, aspectRatio: over.aspect ?? null, aspectDecimal: over.aspectDecimal ?? null, durationMs: over.durationMs ?? null, hasAudio: over.hasAudio ?? null,
      analyzedAt: (over.status ?? "READY") === "READY" ? new Date() : null,
      ...(over.tags ? { tags: { create: over.tags.map((tag) => ({ organizationId: orgId, tag })) } } : {}),
    },
  });
  const src = join(scratch, `${asset.id}.bin`);
  writeFileSync(src, bytes);
  const key = `${orgId}/assets/${asset.id}/original.bin`;
  await libraryStorage().putFile(key, src);
  await prisma.mediaAsset.update({ where: { id: asset.id }, data: { storageKey: key } });
  if (over.thumbnail) {
    const thumbKey = `${orgId}/assets/${asset.id}/thumbnail.jpg`;
    writeFileSync(src, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    await libraryStorage().putFile(thumbKey, src);
    await prisma.mediaDerivative.create({ data: { assetId: asset.id, kind: "THUMBNAIL", storageKey: thumbKey, contentType: "image/jpeg", sizeBytes: 7 } });
  }
  return { asset, bytes, key };
}

suite("Media upload (validation, storage, queueing)", () => {
  useServer();

  it("accepts a valid image: stored once, an asset and a task are created, and ONE job is queued under a deterministic id", async () => {
    const s = await makeOrg("EDITOR");
    const r = await upload(s, "cover.png", PNG(), { mime: "image/png" });
    expect(r.status, r.text).toBe(202);
    const { asset, task } = r.json.data;
    expect(asset).toMatchObject({ originalName: "cover.png", kind: "IMAGE", status: "ANALYZING", downloadOnly: false });
    expect(task).toMatchObject({ type: "MEDIA_ANALYZE", status: "QUEUED" });
    expect(task!.progress).toMatchObject({ mode: "indeterminate", percentage: null }); // nothing measurable yet: no invented number
    expect(JSON.stringify(r.json.data)).not.toContain("storageKey"); // keys never leave the server

    const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset!.id } });
    expect(row.storageKey).toBeTruthy();
    expect(await libraryStorage().exists(row.storageKey!)).toBe(true);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(row.sizeBytes)).toBe(PNG().length);

    const job = await mediaQueue.getJob(mediaProcessingJobId(task!.id));
    expect(job?.data).toEqual({ kind: "ANALYZE_ASSET", taskId: task!.id, assetId: asset!.id });
    expect((await audit(s.orgId, "MEDIA_ASSET_UPLOADED")).length).toBe(1);
  });

  it("accepts each supported type by its real content", async () => {
    const s = await makeOrg("EDITOR");
    const cases: [string, Buffer, string, string][] = [
      ["clip.mp4", MP4, "video/mp4", "VIDEO"],
      ["clip.mov", Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypqt  "), Buffer.alloc(100)]), "video/quicktime", "VIDEO"],
      ["photo.jpg", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 2)]), "image/jpeg", "IMAGE"],
      ["photo.jpeg", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.alloc(60, 4)]), "image/jpeg", "IMAGE"],
      ["pic.webp", Buffer.concat([Buffer.from("RIFF"), Buffer.from([20, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(60, 6)]), "image/webp", "IMAGE"],
      ["song.mp3", Buffer.concat([Buffer.from("ID3"), Buffer.from([3, 0, 0, 0, 0, 0, 0]), Buffer.alloc(60, 7)]), "audio/mpeg", "AUDIO"],
      ["voice.wav", Buffer.concat([Buffer.from("RIFF"), Buffer.from([20, 0, 0, 0]), Buffer.from("WAVE"), Buffer.alloc(60, 8)]), "audio/wav", "AUDIO"],
      ["notes.txt", Buffer.from("some notes\nmore\n"), "text/plain", "TEXT"],
      ["rows.csv", Buffer.from("text,category\nhello,Motivation\n"), "text/csv", "SPREADSHEET"],
      ["sheet.xlsx", Buffer.concat([ZIP, Buffer.from("x")]), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "SPREADSHEET"],
    ];
    for (const [name, data, mime, kind] of cases) {
      const r = await upload(s, name, data, { mime });
      expect(r.status, `${name}: ${r.text}`).toBe(202);
      expect(r.json.data.asset!.kind, name).toBe(kind);
    }
  });

  it("refuses files whose content is not what the name says (signature), with a reason and no stored file", async () => {
    const s = await makeOrg("EDITOR");
    const before = await prisma.mediaAsset.count({ where: { organizationId: s.orgId } });
    const textAsPng = await upload(s, "holiday.png", TEXT, { mime: "image/png" });
    expect(textAsPng.status).toBe(400);
    expect(textAsPng.json.error).toMatchObject({ code: "INVALID_MEDIA", details: { code: "SIGNATURE_MISMATCH" } });
    expect((await upload(s, "clip.mp4", PNG(), { mime: "video/mp4" })).json.error?.details?.code).toBe("SIGNATURE_MISMATCH");
    expect((await upload(s, "photo.png", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]), { mime: "image/png" })).status).toBe(400); // an ELF binary
    expect(await prisma.mediaAsset.count({ where: { organizationId: s.orgId } })).toBe(before);
  });

  it("refuses a declared MIME type that contradicts the extension, an empty file, and unsupported extensions", async () => {
    const s = await makeOrg("EDITOR");
    expect((await upload(s, "a.png", PNG(), { mime: "text/html" })).json.error?.details?.code).toBe("MIME_MISMATCH");
    expect((await upload(s, "empty.png", Buffer.alloc(0), { mime: "image/png" })).status).toBe(400);
    for (const name of ["run.exe", "page.html", "vector.svg", "doc.pdf", "clip.avi", "noext"]) {
      const r = await upload(s, name, TEXT);
      expect(r.status, name).toBe(400);
      expect(r.json.error?.message, name).toMatch(/not a supported file type/i);
    }
  });

  it("refuses a file over the size limit with 413 and keeps nothing", async () => {
    const s = await makeOrg("EDITOR");
    const r = await upload(s, "huge.png", PNG(6_000_000), { mime: "image/png" });
    expect(r.status).toBe(413);
    expect(r.json.error?.code).toBe("INVALID_MEDIA");
    expect(await prisma.mediaAsset.count({ where: { organizationId: s.orgId } })).toBe(0);
  });

  it("answers 400 when no file is sent at all", async () => {
    const s = await makeOrg("EDITOR");
    const form = new FormData();
    form.append("note", "no file here");
    const r = await http("POST", "/api/media/uploads", { cookie: s.cookie, form });
    expect(r.status).toBe(400);
  });

  it("a ZIP becomes a pack with a background extraction task; the original archive is stored untouched", async () => {
    const s = await makeOrg("EDITOR");
    const r = await upload(s, "Summer Release.zip", ZIP, { mime: "application/zip", fields: { packName: "Summer pack" } });
    expect(r.status, r.text).toBe(202);
    const { pack, task } = r.json.data;
    expect(pack).toMatchObject({ name: "Summer pack", status: "PROCESSING", sourceFileName: "Summer Release.zip" });
    expect(task).toMatchObject({ type: "MEDIA_ZIP_EXTRACT", status: "QUEUED" });
    const row = await prisma.mediaPack.findUniqueOrThrow({ where: { id: pack!.id } });
    expect(await libraryStorage().exists(row.sourceArchiveKey!)).toBe(true);
    const stored = await libraryStorage().createReadStream(row.sourceArchiveKey!);
    const chunks: Buffer[] = [];
    for await (const c of stored.stream) chunks.push(Buffer.from(c as Buffer));
    expect(Buffer.concat(chunks).equals(ZIP)).toBe(true);
    expect((await mediaQueue.getJob(mediaProcessingJobId(task!.id)))?.data).toEqual({ kind: "EXTRACT_ZIP", taskId: task!.id, packId: pack!.id });
    expect((await audit(s.orgId, "MEDIA_PACK_UPLOADED")).length).toBe(1);
  });

  it("names a pack after the archive when no name is given, and refuses the same archive twice unless forced", async () => {
    const s = await makeOrg("EDITOR");
    const first = await upload(s, "brand-assets.zip", Buffer.concat([ZIP, Buffer.from("unique-1")]), { mime: "application/zip" });
    expect(first.json.data.pack!.name).toBe("brand-assets");
    const again = await upload(s, "brand-assets-copy.zip", Buffer.concat([ZIP, Buffer.from("unique-1")]), { mime: "application/zip" });
    expect(again.status).toBe(409);
    expect(again.json.error?.details?.packId).toBe(first.json.data.pack!.id);
    const forced = await upload(s, "brand-assets-copy.zip", Buffer.concat([ZIP, Buffer.from("unique-1")]), { mime: "application/zip", fields: { force: "true" } });
    expect(forced.status).toBe(202);
  });

  it("an exact duplicate of an existing asset is recorded as a duplicate: nothing stored, nothing queued; other organizations are separate", async () => {
    const a = await makeOrg("EDITOR");
    const b = await makeOrg("EDITOR");
    const data = PNG(77);
    const first = await upload(a, "one.png", data, { mime: "image/png" });
    const second = await upload(a, "two.png", data, { mime: "image/png" });
    expect(second.status).toBe(200);
    expect(second.json.data).toMatchObject({ duplicate: true, asset: { status: "DUPLICATE", duplicateOf: { id: first.json.data.asset!.id } } });
    expect(second.json.data.task).toBeUndefined();
    const dupRow = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: second.json.data.asset!.id } });
    expect(dupRow.storageKey).toBeNull();
    expect(await prisma.operationTask.count({ where: { organizationId: a.orgId } })).toBe(1);
    const other = await upload(b, "one.png", data, { mime: "image/png" });
    expect(other.json.data.asset!.status).toBe("ANALYZING");
  });

  it("adds a file to an existing pack, and refuses a foreign or archived pack", async () => {
    const a = await makeOrg("EDITOR");
    const b = await makeOrg("EDITOR");
    const pack = await prisma.mediaPack.create({ data: { organizationId: a.orgId, name: "Manual", sourceType: "MANUAL", status: "READY" } });
    const ok = await upload(a, "x.png", PNG(11), { mime: "image/png", fields: { packId: pack.id } });
    expect(ok.json.data.asset!.packId).toBe(pack.id);
    expect((await upload(b, "y.png", PNG(12), { mime: "image/png", fields: { packId: pack.id } })).status).toBe(404);
    await prisma.mediaPack.update({ where: { id: pack.id }, data: { status: "ARCHIVED" } });
    expect((await upload(a, "z.png", PNG(13), { mime: "image/png", fields: { packId: pack.id } })).status).toBe(409);
  });

  it("only editors and above can upload; viewers are refused; no session is 401", async () => {
    const editor = await makeOrg("EDITOR");
    const viewer = await addUser(editor.orgId, "VIEWER");
    expect((await upload(viewer, "v.png", PNG(21), { mime: "image/png" })).status).toBe(403);
    expect((await upload(editor, "e.png", PNG(22), { mime: "image/png" })).status).toBe(202);
    const form = new FormData();
    form.append("file", new Blob([PNG(23)]), "n.png");
    expect((await http("POST", "/api/media/uploads", { form })).status).toBe(401);
  });

  it("leaves no temporary upload files behind", async () => {
    const { readdir } = await import("node:fs/promises");
    const { UPLOAD_TMP_DIR } = await import("../services/media-upload.service.js");
    const s = await makeOrg("EDITOR");
    await upload(s, "tmp-check.png", PNG(31), { mime: "image/png" });
    await upload(s, "tmp-check-bad.png", TEXT, { mime: "image/png" });
    await upload(s, "tmp-check-big.png", PNG(6_000_000), { mime: "image/png" });
    expect(await readdir(UPLOAD_TMP_DIR).catch(() => [] as string[])).toEqual([]);
  });
});

suite("Media library: search, filters, tags, assignment, rights, archive", () => {
  useServer();

  it("lists the usable files by default and hides refused, duplicate and archived ones until asked", async () => {
    const s = await makeOrg("EDITOR");
    const ready = await seedAsset(s.orgId, { name: "ready.png" });
    await seedAsset(s.orgId, { name: "analyzing.png", status: "ANALYZING" });
    await seedAsset(s.orgId, { name: "failed.png", status: "FAILED" });
    await seedAsset(s.orgId, { name: "rejected.png", status: "REJECTED" });
    await seedAsset(s.orgId, { name: "dup.png", status: "DUPLICATE" });
    await seedAsset(s.orgId, { name: "archived.png", status: "ARCHIVED" });
    const names = async (qs = "") => (await get<Paged<AssetDto>>(s, `/api/media/assets${qs}`)).json.data.items.map((i) => i.originalName).sort();
    expect(await names()).toEqual(["analyzing.png", "failed.png", "ready.png"]);
    expect(await names("?status=REJECTED")).toEqual(["rejected.png"]);
    expect(await names("?status=DUPLICATE")).toEqual(["dup.png"]);
    expect(await names("?status=ARCHIVED")).toEqual(["archived.png"]);
    expect((await names("?status=ALL")).length).toBe(6);
    expect(ready.asset.id).toBeTruthy();
  });

  it("searches names, folders and tags; filters by kind, orientation, aspect ratio, duration, size, audio and rights", async () => {
    const s = await makeOrg("EDITOR");
    await seedAsset(s.orgId, { name: "stadium-night.mp4", kind: "VIDEO", mime: "video/mp4", folder: "football/clips", width: 1080, height: 1920, aspect: "9:16", aspectDecimal: 0.5625, durationMs: 15_000, hasAudio: true, tags: ["football", "night"] });
    await seedAsset(s.orgId, { name: "wide-intro.mp4", kind: "VIDEO", mime: "video/mp4", folder: "intro", width: 1920, height: 1080, aspect: "16:9", aspectDecimal: 1.7778, durationMs: 45_000, hasAudio: false, tags: ["intro"] });
    await seedAsset(s.orgId, { name: "square-quote.png", kind: "IMAGE", width: 1000, height: 1000, aspect: "1:1", aspectDecimal: 1, tags: ["motivation"] });
    await seedAsset(s.orgId, { name: "theme.mp3", kind: "AUDIO", mime: "audio/mpeg", durationMs: 120_000, tags: ["music"] });
    const names = async (qs: string) => (await get<Paged<AssetDto>>(s, `/api/media/assets?${qs}`)).json.data.items.map((i) => i.originalName).sort();
    expect(await names("q=stadium")).toEqual(["stadium-night.mp4"]);
    expect(await names("q=football/clips")).toEqual(["stadium-night.mp4"]); // folder
    expect(await names("q=motiv")).toEqual(["square-quote.png"]); // tag
    expect(await names("tag=night")).toEqual(["stadium-night.mp4"]);
    expect(await names("kind=VIDEO")).toEqual(["stadium-night.mp4", "wide-intro.mp4"]);
    expect(await names("orientation=portrait")).toEqual(["stadium-night.mp4"]);
    expect(await names("orientation=landscape")).toEqual(["wide-intro.mp4"]);
    expect(await names("orientation=square")).toEqual(["square-quote.png"]);
    expect(await names("aspect=16:9")).toEqual(["wide-intro.mp4"]);
    expect(await names("kind=VIDEO&minDurationMs=20000")).toEqual(["wide-intro.mp4"]);
    expect(await names("kind=VIDEO&maxDurationMs=20000")).toEqual(["stadium-night.mp4"]);
    expect(await names("minWidth=1500")).toEqual(["wide-intro.mp4"]);
    expect(await names("hasAudio=true&kind=VIDEO")).toEqual(["stadium-night.mp4"]);
    expect(await names("hasAudio=false&kind=VIDEO")).toEqual(["wide-intro.mp4"]);
    expect(await names("rights=CONFIRMED")).toEqual([]);
    expect(await names("q=nothing-matches")).toEqual([]);
  });

  it("sorts and pages without duplicates or gaps", async () => {
    const s = await makeOrg("EDITOR");
    for (const name of ["d.png", "a.png", "c.png", "b.png", "e.png"]) await seedAsset(s.orgId, { name });
    const page = async (sort: string, p: number) => (await get<Paged<AssetDto>>(s, `/api/media/assets?sort=${sort}&pageSize=2&page=${p}`)).json.data;
    const pages = [await page("name", 1), await page("name", 2), await page("name", 3)];
    expect(pages[0]!.total).toBe(5);
    expect(pages.flatMap((p) => p.items.map((i) => i.originalName))).toEqual(["a.png", "b.png", "c.png", "d.png", "e.png"]);
    const newest = (await page("newest", 1)).items.map((i) => i.originalName);
    expect(newest).toEqual(["e.png", "b.png"]); // created last first
  });

  it("filters by campaign and page group, both assigned directly and inherited from the pack", async () => {
    const s = await makeOrg("EDITOR");
    const campaign = await prisma.campaign.create({ data: { organizationId: s.orgId, name: "Camp" } });
    const group = await prisma.pageGroup.create({ data: { organizationId: s.orgId, name: "Net", slug: `net-${randomUUID().slice(0, 5)}` } });
    const pack = await prisma.mediaPack.create({ data: { organizationId: s.orgId, name: "P", sourceType: "MANUAL", status: "READY" } });
    const direct = await seedAsset(s.orgId, { name: "direct.png" });
    const viaPack = await seedAsset(s.orgId, { name: "via-pack.png", packId: pack.id });
    await seedAsset(s.orgId, { name: "unrelated.png" });
    expect((await put(s, `/api/media/assets/${direct.asset.id}/campaigns`, { campaignIds: [campaign.id] })).status).toBe(200);
    expect((await put(s, `/api/media/packs/${pack.id}/campaigns`, { campaignIds: [campaign.id] })).status).toBe(200);
    expect((await put(s, `/api/media/assets/${direct.asset.id}/page-groups`, { groupIds: [group.id] })).status).toBe(200);
    expect((await put(s, `/api/media/packs/${pack.id}/page-groups`, { groupIds: [group.id] })).status).toBe(200);
    const names = async (qs: string) => (await get<Paged<AssetDto>>(s, `/api/media/assets?${qs}`)).json.data.items.map((i) => i.originalName).sort();
    expect(await names(`campaignId=${campaign.id}`)).toEqual(["direct.png", "via-pack.png"]);
    expect(await names(`pageGroupId=${group.id}`)).toEqual(["direct.png", "via-pack.png"]);
    const detail = (await get<AssetDto>(s, `/api/media/assets/${viaPack.asset.id}`)).json.data;
    expect(detail.campaigns).toEqual([]);
    expect(detail.inheritedFromPack?.campaigns.map((c) => c.id)).toEqual([campaign.id]);
    // un-assigning replaces the set
    await put(s, `/api/media/assets/${direct.asset.id}/campaigns`, { campaignIds: [] });
    expect(await names(`campaignId=${campaign.id}`)).toEqual(["via-pack.png"]);
    expect((await audit(s.orgId, "MEDIA_ASSIGNMENT_CHANGED")).length).toBeGreaterThanOrEqual(4);
  });

  it("assignment refuses another organization's campaign or group, assigns nothing, and refuses archived groups", async () => {
    const a = await makeOrg("EDITOR");
    const b = await makeOrg("EDITOR");
    const mine = await prisma.campaign.create({ data: { organizationId: a.orgId, name: "Mine" } });
    const theirs = await prisma.campaign.create({ data: { organizationId: b.orgId, name: "Theirs" } });
    const archivedGroup = await prisma.pageGroup.create({ data: { organizationId: a.orgId, name: "Old", slug: `old-${randomUUID().slice(0, 5)}`, status: "ARCHIVED" } });
    const { asset } = await seedAsset(a.orgId, { name: "x.png" });
    expect((await put(a, `/api/media/assets/${asset.id}/campaigns`, { campaignIds: [mine.id, theirs.id] })).status).toBe(404);
    expect(await prisma.mediaAssetCampaign.count({ where: { assetId: asset.id } })).toBe(0);
    expect((await put(a, `/api/media/assets/${asset.id}/page-groups`, { groupIds: [archivedGroup.id] })).status).toBe(404);
    expect((await put(b, `/api/media/assets/${asset.id}/campaigns`, { campaignIds: [theirs.id] })).status).toBe(404); // not their asset
  });

  it("tags are normalized, de-duplicated and capped; bulk tagging is all-or-nothing; facets count them", async () => {
    const s = await makeOrg("EDITOR");
    const other = await makeOrg("EDITOR");
    const a1 = await seedAsset(s.orgId, { name: "a1.png" });
    const a2 = await seedAsset(s.orgId, { name: "a2.png" });
    const foreign = await seedAsset(other.orgId, { name: "f.png" });
    const set = await put<AssetDto>(s, `/api/media/assets/${a1.asset.id}/tags`, { tags: ["  Football ", "football", "NIGHT  Game", "x"] });
    expect(set.json.data.tags).toEqual(["football", "night game", "x"]);
    expect((await put(s, `/api/media/assets/${a1.asset.id}/tags`, { tags: Array.from({ length: 31 }, (_, i) => `t${i}`) })).status).toBe(400);
    expect((await put(s, `/api/media/assets/${a1.asset.id}/tags`, { tags: ["x".repeat(65)] })).status).toBe(400);

    expect((await post(s, "/api/media/assets/bulk/tags", { assetIds: [a1.asset.id, a2.asset.id], add: ["Shared", "football"], remove: ["x"] })).status).toBe(200);
    expect((await get<AssetDto>(s, `/api/media/assets/${a1.asset.id}`)).json.data.tags).toEqual(["football", "night game", "shared"]);
    expect((await get<AssetDto>(s, `/api/media/assets/${a2.asset.id}`)).json.data.tags).toEqual(["football", "shared"]);
    const rejected = await post(s, "/api/media/assets/bulk/tags", { assetIds: [a1.asset.id, foreign.asset.id], add: ["leak"] });
    expect(rejected.status).toBe(404);
    expect((await get<AssetDto>(s, `/api/media/assets/${a1.asset.id}`)).json.data.tags).not.toContain("leak");

    const facets = (await get<{ total: number; kinds: { kind: string; count: number }[]; tags: { tag: string; count: number }[] }>(s, "/api/media/facets")).json.data;
    expect(facets.total).toBe(2);
    expect(facets.kinds).toEqual([{ kind: "IMAGE", count: 2 }]);
    expect(facets.tags.find((t) => t.tag === "football")).toEqual({ tag: "football", count: 2 });
  });

  it("rights can only be confirmed by an administrator, and the confirmation is recorded", async () => {
    const editor = await makeOrg("EDITOR");
    const admin = await addUser(editor.orgId, "ADMIN");
    const { asset } = await seedAsset(editor.orgId, { name: "song.mp3", kind: "AUDIO", mime: "audio/mpeg" });
    expect((await put(editor, `/api/media/assets/${asset.id}/rights`, { status: "CONFIRMED", notes: "licensed" })).status).toBe(403);
    const r = await put<AssetDto>(admin, `/api/media/assets/${asset.id}/rights`, { status: "CONFIRMED", notes: "Licensed by the label, contract 12" });
    expect(r.status).toBe(200);
    expect(r.json.data.rights.status).toBe("CONFIRMED");
    expect(r.json.data.rights.confirmedAt).not.toBeNull();
    const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row).toMatchObject({ rightsConfirmedById: admin.userId, rightsNotes: "Licensed by the label, contract 12" });
    expect((await audit(editor.orgId, "MEDIA_RIGHTS_CHANGED"))[0]!.metadataJson).toMatchObject({ from: "UNVERIFIED", to: "CONFIRMED" });
    const restricted = await put<AssetDto>(admin, `/api/media/assets/${asset.id}/rights`, { status: "RESTRICTED" });
    expect(restricted.json.data.rights).toMatchObject({ status: "RESTRICTED", confirmedAt: null });
  });

  it("archives and restores assets and packs; an archived pack's files stay out of the default view but open by pack", async () => {
    const s = await makeOrg("EDITOR");
    const pack = await prisma.mediaPack.create({ data: { organizationId: s.orgId, name: "To archive", sourceType: "MANUAL", status: "READY" } });
    const inPack = await seedAsset(s.orgId, { name: "in-pack.png", packId: pack.id });
    const lone = await seedAsset(s.orgId, { name: "lone.png" });
    expect((await post<AssetDto>(s, `/api/media/assets/${lone.asset.id}/archive`)).json.data.status).toBe("ARCHIVED");
    expect((await post<AssetDto>(s, `/api/media/assets/${lone.asset.id}/restore`)).json.data.status).toBe("READY");
    expect((await post<PackDto>(s, `/api/media/packs/${pack.id}/archive`)).json.data.status).toBe("ARCHIVED");
    const names = async (qs = "") => (await get<Paged<AssetDto>>(s, `/api/media/assets${qs}`)).json.data.items.map((i) => i.originalName);
    expect(await names()).toEqual(["lone.png"]);
    expect(await names(`?packId=${pack.id}`)).toEqual(["in-pack.png"]);
    expect((await post<PackDto>(s, `/api/media/packs/${pack.id}/restore`)).json.data.status).toBe("READY");
    expect((await names()).sort()).toEqual(["in-pack.png", "lone.png"]);
    expect(inPack.asset.id).toBeTruthy();
    const processing = await prisma.mediaPack.create({ data: { organizationId: s.orgId, name: "Busy", sourceType: "ZIP", status: "PROCESSING" } });
    expect((await post(s, `/api/media/packs/${processing.id}/archive`)).status).toBe(409);
  });

  it("re-analyze queues a NEW task once, refuses while one is running and for refused files, and leaves the original untouched", async () => {
    const s = await makeOrg("EDITOR");
    const { asset, key } = await seedAsset(s.orgId, { name: "again.png", status: "FAILED" });
    const r = await post<{ task: TaskDto }>(s, `/api/media/assets/${asset.id}/reanalyze`);
    expect(r.status).toBe(202);
    expect((await mediaQueue.getJob(mediaProcessingJobId(r.json.data.task.id)))?.data).toMatchObject({ kind: "ANALYZE_ASSET", assetId: asset.id });
    expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("ANALYZING");
    expect((await post(s, `/api/media/assets/${asset.id}/reanalyze`)).status).toBe(409);
    expect(await libraryStorage().exists(key)).toBe(true);
    const rejected = await seedAsset(s.orgId, { name: "bad.png", status: "REJECTED" });
    expect((await post(s, `/api/media/assets/${rejected.asset.id}/reanalyze`)).status).toBe(409);
  });

  it("packs: list with live counts, detail with the reasons files were refused, edit, and organization isolation", async () => {
    const s = await makeOrg("EDITOR");
    const other = await makeOrg("EDITOR");
    const pack = await prisma.mediaPack.create({ data: { organizationId: s.orgId, name: "Campaign pack", sourceType: "ZIP", status: "PARTIAL", entryCount: 4 } });
    await seedAsset(s.orgId, { name: "ok.png", packId: pack.id });
    await seedAsset(s.orgId, { name: "ok2.png", packId: pack.id });
    await seedAsset(s.orgId, { name: "dup.png", packId: pack.id, status: "DUPLICATE" });
    const refused = await seedAsset(s.orgId, { name: "tool.exe", packId: pack.id, status: "REJECTED" });
    await prisma.mediaAsset.update({ where: { id: refused.asset.id }, data: { rejectionCode: "UNSUPPORTED_TYPE", rejectionReason: "not supported" } });

    const list = (await get<Paged<PackDto>>(s, "/api/media/packs")).json.data;
    expect(list.items[0]!.counts).toMatchObject({ ready: 2, duplicate: 1, rejected: 1, total: 4 });
    const detail = (await get<PackDto>(s, `/api/media/packs/${pack.id}`)).json.data;
    expect(detail.refused).toEqual([expect.objectContaining({ code: "UNSUPPORTED_TYPE", path: expect.stringContaining("tool.exe") })]);
    expect((await http<PackDto>("PATCH", `/api/media/packs/${pack.id}`, { cookie: s.cookie, body: { name: "Renamed", description: "About it" } })).json.data.name).toBe("Renamed");
    expect((await get(other, `/api/media/packs/${pack.id}`)).status).toBe(404);
    expect((await get<Paged<PackDto>>(other, "/api/media/packs")).json.data.total).toBe(0);
    expect((await get<Paged<AssetDto>>(other, "/api/media/assets?status=ALL")).json.data.total).toBe(0);
  });
});

suite("Media library: private streaming, tasks and permissions", () => {
  useServer();

  it("streams a stored file to an authenticated reader of the same organization, with safe headers", async () => {
    const s = await makeOrg("VIEWER");
    const { asset, bytes } = await seedAsset(s.orgId, { name: "pic.png", mime: "image/png" });
    const r = await get(s, `/api/media/assets/${asset.id}/content`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toContain("private");
    expect(r.headers.get("content-disposition")).toContain("inline");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("content-length")).toBe(String(bytes.length));
    expect(r.headers.get("cross-origin-resource-policy")).toBe("same-site");
    const res = await fetch(`${base}/api/media/assets/${asset.id}/content`, { headers: { Cookie: s.cookie } });
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("supports byte ranges for video scrubbing, and refuses impossible ones", async () => {
    const s = await makeOrg("VIEWER");
    const data = Buffer.from("0123456789".repeat(100));
    const { asset } = await seedAsset(s.orgId, { name: "v.mp4", kind: "VIDEO", mime: "video/mp4", bytes: data });
    const part = await fetch(`${base}/api/media/assets/${asset.id}/content`, { headers: { Cookie: s.cookie, Range: "bytes=10-19" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 10-19/${data.length}`);
    expect(part.headers.get("content-length")).toBe("10");
    expect(Buffer.from(await part.arrayBuffer()).toString()).toBe("0123456789");
    const open = await fetch(`${base}/api/media/assets/${asset.id}/content`, { headers: { Cookie: s.cookie, Range: "bytes=990-" } });
    expect(open.status).toBe(206);
    expect(Buffer.from(await open.arrayBuffer()).length).toBe(10);
    const suffix = await fetch(`${base}/api/media/assets/${asset.id}/content`, { headers: { Cookie: s.cookie, Range: "bytes=-5" } });
    expect(Buffer.from(await suffix.arrayBuffer()).toString()).toBe("56789");
    const bad = await fetch(`${base}/api/media/assets/${asset.id}/content`, { headers: { Cookie: s.cookie, Range: "bytes=5000-6000" } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe(`bytes */${data.length}`);
    const junk = await fetch(`${base}/api/media/assets/${asset.id}/content`, { headers: { Cookie: s.cookie, Range: "bytes=1-2,5-6" } });
    expect(junk.status).toBe(200); // a multi-range request is ignored: the whole file is sent
  });

  it("offers text and spreadsheets only as downloads, so nothing user-supplied is rendered in the page", async () => {
    const s = await makeOrg("VIEWER");
    const { asset } = await seedAsset(s.orgId, { name: "notes.txt", kind: "TEXT", mime: "text/plain", bytes: Buffer.from("<script>alert(1)</script>") });
    const r = await get(s, `/api/media/assets/${asset.id}/content`);
    expect(r.headers.get("content-disposition")).toContain("attachment");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(((await get<AssetDto>(s, `/api/media/assets/${asset.id}`)).json.data).downloadOnly).toBe(true);
  });

  it("serves thumbnails, and says so honestly when there is none", async () => {
    const s = await makeOrg("VIEWER");
    const withThumb = await seedAsset(s.orgId, { name: "t.png", thumbnail: true });
    const without = await seedAsset(s.orgId, { name: "n.png" });
    const r = await get(s, `/api/media/assets/${withThumb.asset.id}/thumbnail`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect((await get<AssetDto>(s, `/api/media/assets/${withThumb.asset.id}`)).json.data.thumbnailUrl).toBe(`/api/media/assets/${withThumb.asset.id}/thumbnail`);
    expect((await get<AssetDto>(s, `/api/media/assets/${without.asset.id}`)).json.data.thumbnailUrl).toBeNull();
    expect((await get(s, `/api/media/assets/${without.asset.id}/thumbnail`)).status).toBe(404);
  });

  it("is PRIVATE: no session, or another organization, gets nothing - and the public /media route never serves library files", async () => {
    const a = await makeOrg("VIEWER");
    const b = await makeOrg("VIEWER");
    const { asset, key } = await seedAsset(a.orgId, { name: "secret.png" });
    expect((await http("GET", `/api/media/assets/${asset.id}/content`)).status).toBe(401);
    expect((await get(b, `/api/media/assets/${asset.id}/content`)).status).toBe(404);
    expect((await get(b, `/api/media/assets/${asset.id}/thumbnail`)).status).toBe(404);
    expect((await get(b, `/api/media/assets/${asset.id}`)).status).toBe(404);
    // the static public route serves LOCAL_STORAGE_DIR only; the library lives elsewhere
    expect((await http("GET", `/media/${key}`)).status).toBe(404);
    expect((await http("GET", `/media/${asset.id}/original.bin`)).status).toBe(404);
  });

  it("reports a stored file that has gone missing instead of failing mysteriously", async () => {
    const s = await makeOrg("VIEWER");
    const { asset, key } = await seedAsset(s.orgId, { name: "gone.png" });
    await libraryStorage().delete(key);
    expect((await get(s, `/api/media/assets/${asset.id}/content`)).status).toBe(404);
  });

  it("task progress: a percentage only with a real total; otherwise indeterminate; a silent running task is flagged stalled", async () => {
    const s = await makeOrg("VIEWER");
    const now = Date.now();
    const mk = (over: Record<string, unknown>) => prisma.operationTask.create({ data: { organizationId: s.orgId, type: "MEDIA_ZIP_EXTRACT", ...over } });
    const measurable = await mk({ status: "RUNNING", stage: "Extracting", stageDetail: "a/b.png", completedUnits: 3, totalUnits: 8, unit: "files", startedAt: new Date(now - 30_000), lastProgressAt: new Date(now - 1_000) });
    const unmeasurable = await mk({ status: "RUNNING", stage: "Probing", completedUnits: 0, totalUnits: null, startedAt: new Date(now - 5_000), lastProgressAt: new Date(now - 1_000) });
    const silent = await mk({ status: "RUNNING", stage: "Extracting", completedUnits: 2, totalUnits: 10, startedAt: new Date(now - 20 * 60_000), lastProgressAt: new Date(now - 15 * 60_000) });
    const queued = await mk({ status: "QUEUED", stage: "Queued" });
    const failed = await mk({ status: "FAILED", completedUnits: 2, totalUnits: 5, errorCode: "ZIP_UNSAFE_PATH", errorMessage: "unsafe", errorRemedy: "Do not use this file.", startedAt: new Date(now - 60_000), finishedAt: new Date(now - 30_000) });

    const one = async (id: string) => (await get<TaskDto & { error: { code: string; remedy: string } | null }>(s, `/api/operations/tasks/${id}`)).json.data;
    expect((await one(measurable.id)).progress).toMatchObject({ mode: "determinate", percentage: 37.5, completedUnits: 3, totalUnits: 8, stalled: false });
    expect((await one(measurable.id)).progress.elapsedMs).toBeGreaterThanOrEqual(30_000);
    expect((await one(unmeasurable.id)).progress).toMatchObject({ mode: "indeterminate", percentage: null, totalUnits: null });
    expect((await one(silent.id)).progress).toMatchObject({ mode: "determinate", percentage: 20, stalled: true });
    expect((await one(queued.id)).progress).toMatchObject({ mode: "indeterminate", percentage: null });
    const f = await one(failed.id);
    expect(f.progress).toMatchObject({ percentage: 40 });
    expect(f.error).toMatchObject({ code: "ZIP_UNSAFE_PATH", remedy: "Do not use this file." });

    const active = (await get<{ items: TaskDto[]; activeCount: number }>(s, "/api/operations/tasks?state=active")).json.data;
    expect(active.items.map((t) => t.id).sort()).toEqual([measurable.id, unmeasurable.id, silent.id, queued.id].sort());
    expect(active.activeCount).toBe(4);
    const finished = (await get<{ items: TaskDto[] }>(s, "/api/operations/tasks?state=finished")).json.data;
    expect(finished.items.map((t) => t.id)).toEqual([failed.id]);
    expect((await get<{ items: TaskDto[] }>(s, "/api/operations/tasks?state=all&type=MEDIA_ANALYZE")).json.data.items).toEqual([]);
  });

  it("tasks are private to the organization", async () => {
    const a = await makeOrg("VIEWER");
    const b = await makeOrg("VIEWER");
    const task = await prisma.operationTask.create({ data: { organizationId: a.orgId, type: "MEDIA_ANALYZE", status: "RUNNING" } });
    expect((await get(b, `/api/operations/tasks/${task.id}`)).status).toBe(404);
    expect((await get<{ items: TaskDto[]; activeCount: number }>(b, "/api/operations/tasks?state=all")).json.data).toMatchObject({ items: [], activeCount: 0 });
    expect((await http("GET", "/api/operations/tasks")).status).toBe(401);
  });

  it("every role can read; the write routes need EDITOR (viewers get 403 and nothing changes)", async () => {
    const editor = await makeOrg("EDITOR");
    const viewer = await addUser(editor.orgId, "VIEWER");
    const { asset } = await seedAsset(editor.orgId, { name: "perm.png" });
    const pack = await prisma.mediaPack.create({ data: { organizationId: editor.orgId, name: "P", sourceType: "MANUAL", status: "READY" } });
    for (const path of ["assets", "facets", `assets/${asset.id}`, "packs", `packs/${pack.id}`]) expect((await get(viewer, `/api/media/${path}`)).status, path).toBe(200);
    const writes: [string, string, unknown][] = [
      ["PUT", `assets/${asset.id}/tags`, { tags: ["x"] }],
      ["PUT", `assets/${asset.id}/notes`, { notes: "x" }],
      ["PUT", `assets/${asset.id}/campaigns`, { campaignIds: [] }],
      ["PUT", `assets/${asset.id}/page-groups`, { groupIds: [] }],
      ["POST", `assets/${asset.id}/archive`, {}],
      ["POST", `assets/${asset.id}/reanalyze`, {}],
      ["POST", "assets/bulk/tags", { assetIds: [asset.id], add: ["x"] }],
      ["PATCH", `packs/${pack.id}`, { name: "x" }],
      ["POST", `packs/${pack.id}/archive`, {}],
    ];
    for (const [method, path, body] of writes) expect((await http(method, `/api/media/${path}`, { cookie: viewer.cookie, body })).status, `${method} ${path}`).toBe(403);
    expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("READY");
    expect(await prisma.mediaAssetTag.count({ where: { assetId: asset.id } })).toBe(0);
  });
});
