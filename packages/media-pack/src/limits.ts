/**
 * Upload and extraction limits. Every number is configurable (see @socialith/config MEDIA_*); these defaults are a
 * conservative starting point for a single 4 vCPU / 80 GB VPS, not platform facts.
 */
export interface MediaLimits {
  /** Largest single file, and largest single ZIP entry once inflated. */
  maxFileBytes: number;
  /** Largest uploaded archive file. */
  maxArchiveBytes: number;
  /** Most entries (files + folders) a ZIP may declare. */
  zipMaxEntries: number;
  /** Most bytes all entries may inflate to, in total. */
  zipMaxTotalBytes: number;
  /** Highest accepted inflated/compressed ratio (applies once an entry or the archive inflates past MIN_RATIO_CHECK_BYTES). */
  zipMaxRatio: number;
  /** Deepest folder nesting inside an archive. */
  zipMaxDepth: number;
  /** Longest entry path, in characters. */
  zipMaxPathLength: number;
}

const GiB = 1024 * 1024 * 1024;

export const DEFAULT_MEDIA_LIMITS: MediaLimits = {
  maxFileBytes: 1 * GiB,
  maxArchiveBytes: 2 * GiB,
  zipMaxEntries: 2_000,
  zipMaxTotalBytes: 4 * GiB,
  zipMaxRatio: 100,
  zipMaxDepth: 12,
  zipMaxPathLength: 240,
};

/** Below this many inflated bytes a high ratio is normal (a tiny text file) and is not treated as a bomb. */
export const MIN_RATIO_CHECK_BYTES = 1024 * 1024;

export function withLimits(overrides: Partial<MediaLimits> = {}): MediaLimits {
  return { ...DEFAULT_MEDIA_LIMITS, ...overrides };
}
