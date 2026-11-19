import type { Platform } from "@socialith/database";
import { TikTokProvider } from "./providers/tiktok.provider.js";
import { InstagramProvider } from "./providers/instagram.provider.js";
import { YouTubeProvider } from "./providers/youtube.provider.js";
import type { PublishingProvider } from "./types.js";

const PROVIDERS: Record<Platform, PublishingProvider> = {
  TIKTOK: new TikTokProvider(),
  INSTAGRAM: new InstagramProvider(),
  YOUTUBE: new YouTubeProvider(),
};

export function resolvePublishingProvider(platform: Platform): PublishingProvider {
  return PROVIDERS[platform];
}
