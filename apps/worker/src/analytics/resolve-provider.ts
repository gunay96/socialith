import type { Platform } from "@socialith/database";
import { TikTokAnalyticsProvider } from "./providers/tiktok.analytics-provider.js";
import { InstagramAnalyticsProvider } from "./providers/instagram.analytics-provider.js";
import { YouTubeAnalyticsProvider } from "./providers/youtube.analytics-provider.js";
import type { AnalyticsProvider } from "./types.js";

const PROVIDERS: Record<Platform, AnalyticsProvider> = {
  TIKTOK: new TikTokAnalyticsProvider(),
  INSTAGRAM: new InstagramAnalyticsProvider(),
  YOUTUBE: new YouTubeAnalyticsProvider(),
};

export function resolveAnalyticsProvider(platform: Platform): AnalyticsProvider {
  return PROVIDERS[platform];
}
