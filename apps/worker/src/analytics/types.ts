import type { Platform } from "@socialith/database";

export interface FetchMetricsInput {
  externalPostId: string;
  externalAccountId: string;
  accessToken: string;
}

export interface FetchMetricsResult {
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  raw: Record<string, unknown>;
}

/**
 * Same failure-classification shape as apps/worker/src/publishing/types.ts's
 * PublishError — reused rather than redefined, since the retry/permanent
 * split (auth/content/config = permanent, rate-limit/5xx/network =
 * retryable) is identical reasoning for a metrics fetch as for a publish
 * call.
 */
export type { PublishErrorCode as MetricsErrorCode } from "../publishing/types.js";
export { PublishError as MetricsError } from "../publishing/types.js";

export interface AnalyticsProvider {
  readonly platform: Platform;
  fetchMetrics(input: FetchMetricsInput): Promise<FetchMetricsResult>;
}
