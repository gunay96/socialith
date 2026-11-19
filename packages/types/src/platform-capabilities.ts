/**
 * Real, documentation-derived platform capability matrix — not assumed.
 * Each entry cites what was actually verified (Phase 08/09/10 research
 * against developers.tiktok.com, developers.facebook.com,
 * developers.google.com) rather than guessed. Never claim SUPPORTED for
 * something that was only assumed; PARTIAL/NOT_SUPPORTED/UNVERIFIED are
 * meant to be used honestly.
 */
export type CapabilityStatus = "SUPPORTED" | "PARTIAL" | "REQUIRES_APPROVAL" | "NOT_SUPPORTED" | "NOT_APPLICABLE";

export interface CapabilityDetail {
  status: CapabilityStatus;
  note: string;
}

export interface PlatformCapabilities {
  videoPublishing: CapabilityDetail;
  photoPublishing: CapabilityDetail;
  analytics: CapabilityDetail;
  soundAttachment: CapabilityDetail;
}

export const PLATFORM_CAPABILITIES: Record<"TIKTOK" | "INSTAGRAM" | "YOUTUBE", PlatformCapabilities> = {
  TIKTOK: {
    videoPublishing: {
      status: "REQUIRES_APPROVAL",
      note:
        "This app uses TikTok's real Upload/Inbox flow (video.upload scope, POST /v2/post/publish/inbox/video/init/), not Direct Post — verified against developers.tiktok.com. TikTok's own docs require app-level approval for the video.upload scope itself before it works for real users outside the app's own test users; once delivered, the video lands in the authorizing user's TikTok inbox as a draft — the user must open the TikTok app and manually finish posting it. Socialith's job ends at successful delivery, not at the video going live — see the target's delivery note after a successful upload.",
    },
    photoPublishing: {
      status: "REQUIRES_APPROVAL",
      note: "Same Upload/Inbox flow and video.upload scope-approval requirement as video (TikTok's inbox upload endpoint also accepts photo posts).",
    },
    analytics: {
      status: "SUPPORTED",
      note: "Query Video endpoint (v2/video/query/, video.list scope) returns like/comment/share/view counts for the authenticated user's own already-public videos. A video still sitting in the inbox (not yet manually posted by the user) has no queryable stats yet.",
    },
    soundAttachment: {
      status: "NOT_SUPPORTED",
      note:
        "TikTok's official Content Posting API (Direct Post or Upload/Inbox) has no sound_id/music_id/song_clip_id field, and no official endpoint exposes a sound's audio for re-embedding — verified directly against the API reference (see apps/worker/src/publishing/providers/tiktok.provider.ts).",
    },
  },
  INSTAGRAM: {
    videoPublishing: {
      status: "REQUIRES_APPROVAL",
      note:
        "Real Graph API media-container + publish flow works with Standard Access during development/testing; instagram_content_publish requires Meta App Review (Advanced Access) before it works for accounts outside the app's own testers.",
    },
    photoPublishing: { status: "REQUIRES_APPROVAL", note: "Same permission/App Review requirement as video." },
    analytics: {
      status: "PARTIAL",
      note:
        "Basic fields (like_count, comments_count) work with the same permissions publishing needs. Reach/impressions/saves/shares require the separate /insights edge and additional permissions this app does not request.",
    },
    soundAttachment: {
      status: "NOT_SUPPORTED",
      note:
        "The Instagram Graph API's media container fields (checked while building the publishing adapter) have no audio/music parameter — same real limitation as TikTok, though verified less exhaustively.",
    },
  },
  YOUTUBE: {
    videoPublishing: {
      status: "REQUIRES_APPROVAL",
      note:
        "The real resumable-upload flow works once OAuth is connected; the youtube.upload scope is a Google \"restricted\" scope requiring OAuth consent screen verification/app review before it works for users outside the project's own test users.",
    },
    photoPublishing: { status: "NOT_APPLICABLE", note: "YouTube has no photo-post content type." },
    analytics: {
      status: "SUPPORTED",
      note: "videos.list?part=statistics returns real view/like/comment counts. No share-count metric exists in the YouTube Data API.",
    },
    soundAttachment: { status: "NOT_APPLICABLE", note: "YouTube has no sound/music-library concept comparable to TikTok's." },
  },
};
