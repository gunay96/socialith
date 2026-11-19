import { mkdir, writeFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
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

/**
 * The real storage contract every backend below implements — local disk
 * (dev, credential-free) and R2/S3-compatible object storage (production).
 * Callers (apps/api's upload service, apps/worker's render processor) go
 * through this interface only, never a backend's own class directly, so
 * swapping the backend never touches call sites — see resolveAssetStorage.
 */
export interface AssetStorage {
  readonly kind: "local" | "r2";
  upload(key: string, data: Buffer, contentType?: string): Promise<StoredFile>;
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
  if (key.includes("..") || key.startsWith("/") || key.startsWith("\\")) {
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

  async upload(key: string, data: Buffer): Promise<StoredFile> {
    const absolutePath = this.resolvePath(key);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, data);
    return { key, url: `${this.config.baseUrl}/${key.split("\\").join("/")}` };
  }

  async getDownloadUrl(key: string): Promise<string> {
    assertSafeKey(key);
    return `${this.config.baseUrl}/${key.split("\\").join("/")}`;
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
}

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

  constructor(config: R2StorageConfig) {
    const clientConfig: S3ClientConfig = {
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    };
    this.client = new S3Client(clientConfig);
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
