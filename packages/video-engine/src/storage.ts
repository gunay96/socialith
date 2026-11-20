import { createReadStream as fsCreateReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StoredFile {
  /** Path relative to the storage root — what gets persisted as ContentAsset.metadata for later lookup, not just the URL. */
  key: string;
  url: string;
}

export interface AssetMetadata {
  sizeBytes: number;
  contentType: string | null;
  lastModified: Date | null;
}

/** A byte range (inclusive), as in an HTTP Range header. */
export interface ByteRange {
  start: number;
  end?: number;
}

export interface ObjectReadStream {
  stream: Readable;
  /** Total size of the object (not of the range). */
  sizeBytes: number;
  contentType: string | null;
  /** The range actually served, when one was requested. */
  range?: { start: number; end: number };
}

export interface PutFileOptions {
  contentType?: string;
  /**
   * Default false: writing to a key that already exists fails with StorageKeyExistsError. Originals are immutable, so
   * the library never overwrites; only code that deliberately replaces a derivative passes true.
   */
  overwrite?: boolean;
}

/** Thrown instead of overwriting an existing object. */
export class StorageKeyExistsError extends Error {
  constructor(readonly key: string) {
    super(`Storage key already exists and will not be overwritten: ${key}`);
    this.name = "StorageKeyExistsError";
  }
}

/**
 * The real storage contract every backend below implements — local disk
 * (dev, credential-free) and R2/S3-compatible object storage (production).
 * Callers (apps/api's upload service, apps/worker's render processor) go
 * through this interface only, never a backend's own class directly, so
 * swapping the backend never touches call sites — see resolveAssetStorage.
 *
 * Two families of write/read methods:
 *  - `upload` / buffer methods: the original Phase 05-10 API, fine for small files, kept unchanged for existing callers.
 *  - `putFile` / `createReadStream` / `downloadToFile`: STREAMING. They never hold a file in memory, so multi-hundred-MB
 *    videos and archives are safe. Everything in the media library uses these.
 */
export interface AssetStorage {
  readonly kind: "local" | "r2";
  upload(key: string, data: Buffer, contentType?: string): Promise<StoredFile>;
  /** Streams a local file into storage. */
  putFile(key: string, filePath: string, options?: PutFileOptions): Promise<StoredFile>;
  /** Streams an object out, optionally a byte range of it. */
  createReadStream(key: string, range?: ByteRange): Promise<ObjectReadStream>;
  /** Streams an object to a local file. */
  downloadToFile(key: string, destinationPath: string): Promise<void>;
  /**
   * A URL the browser/platform can actually fetch the file from.
   * Local: the real (unauthenticated, see apps/api/src/app.ts's /media
   * route comment) static URL — there is no local signing capability.
   * R2: a real presigned GET URL, time-limited (defaults to 1 hour) —
   * this is what "favor signed/controlled access" (Phase 10 §10) means in
   * practice for a bucket that is not configured as publicly readable.
   * If R2_PUBLIC_URL is configured (a public bucket/custom domain), that
   * stable URL is returned instead of a presigned one.
   */
  getDownloadUrl(key: string, expiresInSeconds?: number): Promise<string>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  getMetadata(key: string): Promise<AssetMetadata | null>;
}

function assertSafeKey(key: string): void {
  // Keys are always server-generated (org id + cuid segments — see
  // apps/api/src/services/content-asset-upload.service.ts and
  // apps/worker's render processor), never taken from client input
  // directly, but this guards against a path-traversal key regardless of
  // where it originates.
  if (key.length === 0 || key.includes("..") || key.startsWith("/") || key.startsWith("\\") || key.includes("\0") || /^[A-Za-z]:/.test(key)) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}

export interface LocalStorageConfig {
  /** Absolute directory every stored file lives under. */
  baseDir: string;
  /** Absolute URL prefix apps/api serves `baseDir` at, no trailing slash (e.g. "http://localhost:4000/media"). */
  baseUrl: string;
}

/**
 * Local-filesystem asset storage — the real, credential-free dev backend
 * (see apps/api/src/app.ts's /media static route). Not a stand-in for R2;
 * a genuine, fully functional storage backend real files are written to
 * and read back from.
 */
export class LocalAssetStorage implements AssetStorage {
  readonly kind = "local" as const;

  constructor(private readonly config: LocalStorageConfig) {}

  private resolvePath(key: string): string {
    assertSafeKey(key);
    return join(this.config.baseDir, key);
  }

  private urlFor(key: string): string {
    return `${this.config.baseUrl}/${key.split("\\").join("/")}`;
  }

  async upload(key: string, data: Buffer): Promise<StoredFile> {
    const absolutePath = this.resolvePath(key);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, data);
    return { key, url: this.urlFor(key) };
  }

  async putFile(key: string, filePath: string, options: PutFileOptions = {}): Promise<StoredFile> {
    const absolutePath = this.resolvePath(key);
    if (!options.overwrite && (await this.exists(key))) throw new StorageKeyExistsError(key);
    await mkdir(dirname(absolutePath), { recursive: true });
    // write beside the target and rename, so a reader (or a crash) never sees a half-written file
    const partial = `${absolutePath}.${randomUUID()}.partial`;
    try {
      await pipeline(fsCreateReadStream(filePath), createWriteStream(partial));
      await rename(partial, absolutePath);
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
    return { key, url: this.urlFor(key) };
  }

  async createReadStream(key: string, range?: ByteRange): Promise<ObjectReadStream> {
    const absolutePath = this.resolvePath(key);
    const { size } = await stat(absolutePath);
    if (!range) return { stream: fsCreateReadStream(absolutePath), sizeBytes: size, contentType: null };
    const end = Math.min(range.end ?? size - 1, size - 1);
    if (range.start < 0 || range.start > end) throw new RangeError(`Unsatisfiable range ${range.start}-${range.end ?? ""} for an object of ${size} bytes`);
    return { stream: fsCreateReadStream(absolutePath, { start: range.start, end }), sizeBytes: size, contentType: null, range: { start: range.start, end } };
  }

  async downloadToFile(key: string, destinationPath: string): Promise<void> {
    const { stream } = await this.createReadStream(key);
    await mkdir(dirname(destinationPath), { recursive: true });
    await pipeline(stream, createWriteStream(destinationPath));
  }

  async getDownloadUrl(key: string): Promise<string> {
    assertSafeKey(key);
    return this.urlFor(key);
  }

  async delete(key: string): Promise<void> {
    await unlink(this.resolvePath(key)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
  }

  async exists(key: string): Promise<boolean> {
    return stat(this.resolvePath(key))
      .then(() => true)
      .catch(() => false);
  }

  async getMetadata(key: string): Promise<AssetMetadata | null> {
    try {
      const s = await stat(this.resolvePath(key));
      return { sizeBytes: s.size, contentType: null, lastModified: s.mtime };
    } catch {
      return null;
    }
  }
}

export interface R2StorageConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  /** A public bucket/custom domain URL, if configured — see AssetStorage.getDownloadUrl. */
  publicUrl?: string;
  /**
   * Overrides the endpoint. Empty = Cloudflare R2's own (https://<accountId>.r2.cloudflarestorage.com). Setting it
   * points the same adapter at any S3-compatible service (path-style addressing is then used), which is how the
   * adapter is exercised against a local S3 server in tests.
   */
  endpoint?: string;
}

/** Streaming multipart upload settings: 8 MiB parts, four in flight - bounded memory (<= 32 MiB) however large the file. */
const MULTIPART_PART_BYTES = 8 * 1024 * 1024;
const MULTIPART_QUEUE_SIZE = 4;

/**
 * Cloudflare R2 — S3-compatible, so the AWS SDK's S3Client talks to it
 * directly against R2's own endpoint (https://<accountId>.r2.cloudflarestorage.com),
 * region "auto" per Cloudflare's own documented S3-compatibility contract.
 * Never faked: this class makes real S3-protocol calls, and is only ever
 * selected by resolveAssetStorage when real R2 credentials are present —
 * see its own doc for the CONFIGURATION_ERROR-first behavior otherwise.
 */
export class R2AssetStorage implements AssetStorage {
  readonly kind = "r2" as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string | undefined;

  constructor(config: R2StorageConfig, client?: S3Client) {
    const clientConfig: S3ClientConfig = {
      region: "auto",
      endpoint: config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // Plain S3 requests that every S3-compatible service accepts: no automatic trailing checksums on streamed bodies
      // (newer SDK defaults add them, and S3-compatible stores differ in how they handle them). Not verified live on R2.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      ...(config.endpoint ? { forcePathStyle: true } : {}),
    };
    this.client = client ?? new S3Client(clientConfig);
    this.bucket = config.bucketName;
    this.publicUrl = config.publicUrl;
  }

  async upload(key: string, data: Buffer, contentType?: string): Promise<StoredFile> {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }),
    );
    return { key, url: await this.getDownloadUrl(key) };
  }

  async putFile(key: string, filePath: string, options: PutFileOptions = {}): Promise<StoredFile> {
    assertSafeKey(key);
    if (!options.overwrite && (await this.exists(key))) throw new StorageKeyExistsError(key);
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: fsCreateReadStream(filePath), ContentType: options.contentType },
      partSize: MULTIPART_PART_BYTES,
      queueSize: MULTIPART_QUEUE_SIZE,
      leavePartsOnError: false,
    });
    await upload.done();
    return { key, url: await this.getDownloadUrl(key) };
  }

  async createReadStream(key: string, range?: ByteRange): Promise<ObjectReadStream> {
    assertSafeKey(key);
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(range ? { Range: `bytes=${range.start}-${range.end ?? ""}` } : {}) }),
    );
    const body = res.Body as Readable | undefined;
    if (!body) throw new Error(`Object has no body: ${key}`);
    // ContentRange is "bytes start-end/total" for a ranged response
    const match = res.ContentRange ? /bytes (\d+)-(\d+)\/(\d+)/.exec(res.ContentRange) : null;
    return {
      stream: body,
      sizeBytes: match ? Number(match[3]) : (res.ContentLength ?? 0),
      contentType: res.ContentType ?? null,
      ...(match ? { range: { start: Number(match[1]), end: Number(match[2]) } } : {}),
    };
  }

  async downloadToFile(key: string, destinationPath: string): Promise<void> {
    const { stream } = await this.createReadStream(key);
    await mkdir(dirname(destinationPath), { recursive: true });
    await pipeline(stream, createWriteStream(destinationPath));
  }

  async getDownloadUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    assertSafeKey(key);
    if (this.publicUrl) {
      return `${this.publicUrl}/${key}`;
    }
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async getMetadata(key: string): Promise<AssetMetadata | null> {
    assertSafeKey(key);
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        sizeBytes: head.ContentLength ?? 0,
        contentType: head.ContentType ?? null,
        lastModified: head.LastModified ?? null,
      };
    } catch {
      return null;
    }
  }
}

export interface ResolveAssetStorageInput {
  /** Present only when every R2_* credential is actually configured — see packages/config's R2_* schema fields. */
  r2?: R2StorageConfig;
  local: LocalStorageConfig;
}

/**
 * The one place either backend gets selected — R2 when real credentials
 * are configured, the real local backend otherwise. Never a silent
 * partial-R2 config: callers only pass `r2` when accountId/accessKeyId/
 * secretAccessKey are all present (see call sites), so an incomplete R2
 * config simply falls back to local rather than constructing a client
 * that would fail on its first real call.
 */
export function resolveAssetStorage(input: ResolveAssetStorageInput): AssetStorage {
  if (input.r2) {
    return new R2AssetStorage(input.r2);
  }
  return new LocalAssetStorage(input.local);
}
