import type { AspectRatio } from "@socialith/publishing";

/**
 * Safe areas: the part of the frame text should stay inside so a platform's own interface (profile name, caption,
 * buttons, progress bar) does not cover it.
 *
 * ASSUMPTION, not measured: these margins are conservative values for short-form vertical video. The platforms do not
 * publish exact, stable zones and they change; nothing here was verified against a live account (same status as the
 * platform limits in the Publishing Center, TD-50). They are fractions of the frame, kept in one place so they are easy
 * to correct once real accounts are checked.
 */
export interface SafeArea {
  top: number;
  bottom: number;
  side: number;
}

export const SAFE_AREAS: Record<AspectRatio, SafeArea> = {
  "9:16": { top: 0.08, bottom: 0.16, side: 0.06 },
  "4:5": { top: 0.05, bottom: 0.08, side: 0.05 },
  "1:1": { top: 0.05, bottom: 0.06, side: 0.05 },
  "16:9": { top: 0.06, bottom: 0.1, side: 0.05 },
};

export const SAFE_AREA_STATUS = "ASSUMED" as const;

export function safeAreaPx(ratio: AspectRatio, frame: { width: number; height: number }): { top: number; bottom: number; left: number; right: number } {
  const s = SAFE_AREAS[ratio];
  return { top: Math.round(s.top * frame.height), bottom: Math.round(s.bottom * frame.height), left: Math.round(s.side * frame.width), right: Math.round(s.side * frame.width) };
}
