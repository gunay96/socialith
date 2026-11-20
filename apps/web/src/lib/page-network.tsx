"use client";

import { useCurrentUser } from "@/lib/auth-context";
import { PLATFORM_LABEL } from "@/lib/publishing";
import { Chip, TONES, inputClass } from "@/lib/upload-post";

// ------------------------------------------------------------------------------------------------ types

export type Status = "ACTIVE" | "ARCHIVED";
export type MappingState = "NO_DESTINATION" | "READY" | "REAUTH_REQUIRED" | "DISCONNECTED" | "UNAVAILABLE";
export const PLATFORMS = ["INSTAGRAM", "TIKTOK", "YOUTUBE"] as const;
export const ASPECT_RATIOS = ["9:16", "4:5", "1:1", "16:9"] as const;
export const TEXT_POSITIONS = ["TOP", "UPPER_THIRD", "CENTER", "LOWER_THIRD", "BOTTOM"] as const;

export interface EditorialProfile {
  contentPreferences?: { formats?: string[]; topics?: string[]; avoidTopics?: string[]; avoidTerms?: string[]; maxTextLength?: number | null; requiresVerifiedFacts?: boolean };
  visual?: { style?: string | null; fonts?: string[]; colors?: string[]; textPosition?: string | null; aspectRatio?: string | null };
  guidelines?: string | null;
  originality?: { similarityThresholdPct?: number | null; lookbackPosts?: number | null };
  ruleEnforcement?: "WARN" | "BLOCK" | null;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  language: string;
  defaultEditorialStyle: string | null;
  contentPreferences: EditorialProfile | null;
  status: Status;
  pageCount?: number;
}

export interface PageItem {
  id: string;
  name: string;
  slug: string;
  status: Status;
  platform: string | null;
  username: string | null;
  profileUrl: string | null;
  description: string | null;
  targetAudience: string | null;
  language: string | null;
  effectiveLanguage: string | null;
  category: { id: string; name: string; status: Status } | null;
  groups: { id: string; name: string }[];
  mapping: { state: MappingState; stateLabel: string; destination: { id: string; handle: string; provider: string; status: string } | null };
  incomplete: string[];
}

export interface Issue {
  code: string;
  severity: string;
  message: string;
}

export interface Mapping {
  state: MappingState;
  stateLabel: string;
  linked: boolean;
  issues: Issue[];
  destination: { id: string; platform: string; handle: string; displayName: string; provider: string; status: string; lastErrorMessage: string | null } | null;
  upload: { accountId: string; accountStatus: string; platform: string; reauthRequired: boolean; lastSeenAt: string | null; profileStatus: string; profileBlocked: boolean; profile: { id: string; username: string } | null } | null;
  publishing: { canPublish: boolean; provider: string | null; platform: string | null; capabilities: string[] };
  lastSyncedAt: string | null;
  usernameMatchesDestination: boolean | null;
  profileMappedToOtherPage: { id: string; name: string } | null;
  uploadPostProfiles: { id: string; username: string | null; status: string; blocked: boolean; accountCount: number }[];
}

export type FieldSource = "page" | "group" | "category" | "default" | "unset";

export interface Identity {
  editorialStyle: string | null;
  language: string | null;
  contentPreferences: { formats: string[]; topics: string[]; avoidTopics: string[]; avoidTerms: string[]; maxTextLength: number | null; requiresVerifiedFacts: boolean };
  visual: { style: string | null; fonts: string[]; colors: string[]; textPosition: string | null; aspectRatio: string | null };
  guidelines: string | null;
  originality: { similarityThresholdPct: number | null; lookbackPosts: number };
  ruleEnforcement: "WARN" | "BLOCK";
  sources: Record<string, FieldSource>;
}

export interface FormatDef {
  id: string;
  label: string;
  description: string;
  aspectRatios: string[];
  needsVerifiedFacts: boolean;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ------------------------------------------------------------------------------------------------ small pieces

export function useIsAdmin(): boolean {
  const me = useCurrentUser();
  return me.role === "ADMIN" || me.role === "OWNER";
}

const MAPPING_TONE: Record<MappingState, string> = {
  READY: TONES.GREEN,
  NO_DESTINATION: TONES.NEUTRAL,
  REAUTH_REQUIRED: TONES.AMBER,
  DISCONNECTED: TONES.RED,
  UNAVAILABLE: TONES.RED,
};

export function MappingBadge({ state, label }: { state: MappingState; label?: string }) {
  const text = label ?? state.replace(/_/g, " ").toLowerCase();
  return <Chip tone={MAPPING_TONE[state]}>{text}</Chip>;
}

export function PlatformChip({ platform }: { platform: string | null }) {
  return <Chip>{platform ? (PLATFORM_LABEL[platform] ?? platform) : "no platform"}</Chip>;
}

export function StatusChip({ status }: { status: Status }) {
  return <Chip tone={status === "ACTIVE" ? TONES.GREEN : TONES.NEUTRAL}>{status === "ACTIVE" ? "active" : "archived"}</Chip>;
}

const SOURCE_TEXT: Record<FieldSource, string> = { page: "set on this page", group: "from the group", category: "inherited from the category", default: "built-in default", unset: "not set anywhere" };
export function SourceTag({ source }: { source: FieldSource | undefined }) {
  if (!source) return null;
  return <Chip tone={source === "page" ? TONES.BLUE : TONES.NEUTRAL} title={SOURCE_TEXT[source]}>{source}</Chip>;
}

export const labelClass = "flex flex-col gap-1 text-sm";
export const hintClass = "text-xs text-muted";

// ------------------------------------------------------------------------------------------------ profile editor

/** The editor works on text; lists are typed one per line or comma-separated. */
export interface ProfileDraft {
  formats: string[];
  topics: string;
  avoidTopics: string;
  avoidTerms: string;
  maxTextLength: string;
  requiresVerifiedFacts: "" | "true" | "false";
  visualStyle: string;
  fonts: string;
  colors: string;
  textPosition: string;
  aspectRatio: string;
  guidelines: string;
  similarityThresholdPct: string;
  lookbackPosts: string;
  ruleEnforcement: "" | "WARN" | "BLOCK";
}

export const EMPTY_DRAFT: ProfileDraft = {
  formats: [],
  topics: "",
  avoidTopics: "",
  avoidTerms: "",
  maxTextLength: "",
  requiresVerifiedFacts: "",
  visualStyle: "",
  fonts: "",
  colors: "",
  textPosition: "",
  aspectRatio: "",
  guidelines: "",
  similarityThresholdPct: "",
  lookbackPosts: "",
  ruleEnforcement: "",
};

const joinList = (v: string[] | undefined) => (v ?? []).join("\n");
const splitList = (v: string) => [...new Set(v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];
const num = (v: string): number | undefined => (v.trim() === "" || Number.isNaN(Number(v)) ? undefined : Number(v));

export function profileToDraft(p: EditorialProfile | null | undefined): ProfileDraft {
  return {
    formats: p?.contentPreferences?.formats ?? [],
    topics: joinList(p?.contentPreferences?.topics),
    avoidTopics: joinList(p?.contentPreferences?.avoidTopics),
    avoidTerms: joinList(p?.contentPreferences?.avoidTerms),
    maxTextLength: p?.contentPreferences?.maxTextLength != null ? String(p.contentPreferences.maxTextLength) : "",
    requiresVerifiedFacts: p?.contentPreferences?.requiresVerifiedFacts === undefined ? "" : p.contentPreferences.requiresVerifiedFacts ? "true" : "false",
    visualStyle: p?.visual?.style ?? "",
    fonts: joinList(p?.visual?.fonts),
    colors: joinList(p?.visual?.colors),
    textPosition: p?.visual?.textPosition ?? "",
    aspectRatio: p?.visual?.aspectRatio ?? "",
    guidelines: p?.guidelines ?? "",
    similarityThresholdPct: p?.originality?.similarityThresholdPct != null ? String(p.originality.similarityThresholdPct) : "",
    lookbackPosts: p?.originality?.lookbackPosts != null ? String(p.originality.lookbackPosts) : "",
    ruleEnforcement: p?.ruleEnforcement ?? "",
  };
}

/** Only what is filled in is sent: blank means "inherit", and an all-blank draft is null. */
export function draftToProfile(d: ProfileDraft): EditorialProfile | null {
  const cp: NonNullable<EditorialProfile["contentPreferences"]> = {};
  if (d.formats.length) cp.formats = d.formats;
  if (splitList(d.topics).length) cp.topics = splitList(d.topics);
  if (splitList(d.avoidTopics).length) cp.avoidTopics = splitList(d.avoidTopics);
  if (splitList(d.avoidTerms).length) cp.avoidTerms = splitList(d.avoidTerms);
  if (num(d.maxTextLength) !== undefined) cp.maxTextLength = num(d.maxTextLength)!;
  if (d.requiresVerifiedFacts) cp.requiresVerifiedFacts = d.requiresVerifiedFacts === "true";
  const v: NonNullable<EditorialProfile["visual"]> = {};
  if (d.visualStyle.trim()) v.style = d.visualStyle.trim();
  if (splitList(d.fonts).length) v.fonts = splitList(d.fonts);
  if (splitList(d.colors).length) v.colors = splitList(d.colors);
  if (d.textPosition) v.textPosition = d.textPosition;
  if (d.aspectRatio) v.aspectRatio = d.aspectRatio;
  const o: NonNullable<EditorialProfile["originality"]> = {};
  if (num(d.similarityThresholdPct) !== undefined) o.similarityThresholdPct = num(d.similarityThresholdPct)!;
  if (num(d.lookbackPosts) !== undefined) o.lookbackPosts = num(d.lookbackPosts)!;
  const out: EditorialProfile = {};
  if (Object.keys(cp).length) out.contentPreferences = cp;
  if (Object.keys(v).length) out.visual = v;
  if (d.guidelines.trim()) out.guidelines = d.guidelines.trim();
  if (Object.keys(o).length) out.originality = o;
  if (d.ruleEnforcement) out.ruleEnforcement = d.ruleEnforcement;
  return Object.keys(out).length ? out : null;
}

const POSITION_LABEL: Record<string, string> = { TOP: "Top", UPPER_THIRD: "Upper third", CENTER: "Center", LOWER_THIRD: "Lower third", BOTTOM: "Bottom" };

/**
 * One editor for category defaults, group preferences and page overrides. On a page, a blank field means "inherit";
 * `inherited` (the effective values without the page's own) is shown as the placeholder so the editor can see what a
 * blank field currently resolves to.
 */
export function ProfileEditor({ draft, onChange, formats, disabled, inherited, sources }: {
  draft: ProfileDraft;
  onChange: (next: ProfileDraft) => void;
  formats: FormatDef[];
  disabled?: boolean;
  inherited?: Identity | null;
  sources?: Record<string, FieldSource>;
}) {
  const set = (patch: Partial<ProfileDraft>) => onChange({ ...draft, ...patch });
  const ph = (value: string | number | null | undefined, fallback = "") => (value === null || value === undefined || value === "" ? fallback : String(value));
  const src = (key: string) => (sources ? <SourceTag source={sources[key]} /> : null);
  const listPh = (v: string[] | undefined) => (v && v.length ? v.join(", ") : "");
  const colors = splitList(draft.colors);

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-3" disabled={disabled}>
        <legend className="mb-1 text-xs font-semibold uppercase tracking-widest text-muted">Content preferences</legend>
        <div className={labelClass}>
          <span className="flex items-center gap-2">Editorial formats {src("contentPreferences.formats")}</span>
          <div className="flex flex-wrap gap-2">
            {formats.map((f) => {
              const on = draft.formats.includes(f.id);
              return (
                <label key={f.id} title={f.description} className={`flex cursor-pointer items-center gap-2 rounded border px-2 py-1 text-xs ${on ? "border-accent bg-accent/10" : "border-border"}`}>
                  <input type="checkbox" checked={on} onChange={(e) => set({ formats: e.target.checked ? [...draft.formats, f.id] : draft.formats.filter((x) => x !== f.id) })} />
                  {f.label}
                  {f.needsVerifiedFacts && <Chip tone={TONES.AMBER}>facts</Chip>}
                </label>
              );
            })}
          </div>
          <span className={hintClass}>Definitions only for now: formats are rendered by the Media Pack / Format Engine in a later phase.{inherited && listPh(inherited.contentPreferences.formats) ? ` Currently resolves to: ${inherited.contentPreferences.formats.join(", ")}.` : ""}</span>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <label className={labelClass}>
            <span className="flex items-center gap-2">Topics {src("contentPreferences.topics")}</span>
            <textarea rows={3} value={draft.topics} onChange={(e) => set({ topics: e.target.value })} placeholder={listPh(inherited?.contentPreferences.topics)} className={inputClass} />
            <span className={hintClass}>One per line or comma-separated.</span>
          </label>
          <label className={labelClass}>
            <span className="flex items-center gap-2">Topics to avoid {src("contentPreferences.avoidTopics")}</span>
            <textarea rows={3} value={draft.avoidTopics} onChange={(e) => set({ avoidTopics: e.target.value })} placeholder={listPh(inherited?.contentPreferences.avoidTopics)} className={inputClass} />
          </label>
          <label className={labelClass}>
            <span className="flex items-center gap-2">Terms that must not appear {src("contentPreferences.avoidTerms")}</span>
            <textarea rows={3} value={draft.avoidTerms} onChange={(e) => set({ avoidTerms: e.target.value })} placeholder={listPh(inherited?.contentPreferences.avoidTerms)} className={inputClass} />
            <span className={hintClass}>Checked case-insensitively at the start of a word.</span>
          </label>
        </div>
        <div className="flex flex-wrap gap-4">
          <label className={labelClass}>
            <span className="flex items-center gap-2">Longest text (characters) {src("contentPreferences.maxTextLength")}</span>
            <input type="number" min={1} max={10000} value={draft.maxTextLength} onChange={(e) => set({ maxTextLength: e.target.value })} placeholder={ph(inherited?.contentPreferences.maxTextLength, "no limit")} className={`${inputClass} w-40`} />
          </label>
          <label className={labelClass}>
            <span className="flex items-center gap-2">Facts must be verified {src("contentPreferences.requiresVerifiedFacts")}</span>
            <select value={draft.requiresVerifiedFacts} onChange={(e) => set({ requiresVerifiedFacts: e.target.value as ProfileDraft["requiresVerifiedFacts"] })} className={`${inputClass} w-56`}>
              <option value="">Inherit{inherited ? ` (${inherited.contentPreferences.requiresVerifiedFacts ? "yes" : "no"})` : ""}</option>
              <option value="true">Yes - remind the approver</option>
              <option value="false">No</option>
            </select>
            <span className={hintClass}>A reminder only: Socialith does not verify facts.</span>
          </label>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3" disabled={disabled}>
        <legend className="mb-1 text-xs font-semibold uppercase tracking-widest text-muted">Visual preferences</legend>
        <label className={labelClass}>
          <span className="flex items-center gap-2">Visual style {src("visual.style")}</span>
          <input value={draft.visualStyle} onChange={(e) => set({ visualStyle: e.target.value })} placeholder={ph(inherited?.visual.style)} className={inputClass} maxLength={300} />
        </label>
        <div className="grid gap-3 md:grid-cols-2">
          <label className={labelClass}>
            <span className="flex items-center gap-2">Preferred fonts {src("visual.fonts")}</span>
            <textarea rows={2} value={draft.fonts} onChange={(e) => set({ fonts: e.target.value })} placeholder={listPh(inherited?.visual.fonts)} className={inputClass} />
          </label>
          <label className={labelClass}>
            <span className="flex items-center gap-2">Preferred colors (hex) {src("visual.colors")}</span>
            <textarea rows={2} value={draft.colors} onChange={(e) => set({ colors: e.target.value })} placeholder={listPh(inherited?.visual.colors) || "#ff6a00"} className={inputClass} />
            {colors.length > 0 && (
              <span className="flex gap-1">
                {colors.map((c) => (
                  <span key={c} title={c} className="h-4 w-4 rounded border border-border" style={{ backgroundColor: /^#[0-9a-fA-F]{3,6}$/.test(c) ? c : "transparent" }} />
                ))}
              </span>
            )}
          </label>
        </div>
        <div className="flex flex-wrap gap-4">
          <label className={labelClass}>
            <span className="flex items-center gap-2">Text position {src("visual.textPosition")}</span>
            <select value={draft.textPosition} onChange={(e) => set({ textPosition: e.target.value })} className={`${inputClass} w-48`}>
              <option value="">Inherit{inherited?.visual.textPosition ? ` (${POSITION_LABEL[inherited.visual.textPosition] ?? inherited.visual.textPosition})` : ""}</option>
              {TEXT_POSITIONS.map((p) => (
                <option key={p} value={p}>{POSITION_LABEL[p]}</option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            <span className="flex items-center gap-2">Preferred aspect ratio {src("visual.aspectRatio")}</span>
            <select value={draft.aspectRatio} onChange={(e) => set({ aspectRatio: e.target.value })} className={`${inputClass} w-48`}>
              <option value="">Inherit{inherited?.visual.aspectRatio ? ` (${inherited.visual.aspectRatio})` : ""}</option>
              {ASPECT_RATIOS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </label>
        </div>
        <span className={hintClass}>Preferences only: no media is rendered and no text is placed automatically yet (Media Packs, Phase 5).</span>
      </fieldset>

      <fieldset className="flex flex-col gap-3" disabled={disabled}>
        <legend className="mb-1 text-xs font-semibold uppercase tracking-widest text-muted">Guidelines and originality</legend>
        <label className={labelClass}>
          <span className="flex items-center gap-2">Content guidelines {src("guidelines")}</span>
          <textarea rows={3} value={draft.guidelines} onChange={(e) => set({ guidelines: e.target.value })} placeholder={ph(inherited?.guidelines)} className={inputClass} maxLength={4000} />
        </label>
        <div className="flex flex-wrap gap-4">
          <label className={labelClass}>
            <span className="flex items-center gap-2">Repeat threshold (%) {src("originality.similarityThresholdPct")}</span>
            <input type="number" min={1} max={100} value={draft.similarityThresholdPct} onChange={(e) => set({ similarityThresholdPct: e.target.value })} placeholder={ph(inherited?.originality.similarityThresholdPct, "organization setting")} className={`${inputClass} w-44`} />
          </label>
          <label className={labelClass}>
            <span className="flex items-center gap-2">Compare with the last N posts {src("originality.lookbackPosts")}</span>
            <input type="number" min={0} max={200} value={draft.lookbackPosts} onChange={(e) => set({ lookbackPosts: e.target.value })} placeholder={ph(inherited?.originality.lookbackPosts, "30")} className={`${inputClass} w-44`} />
            <span className={hintClass}>0 switches the originality check off for this page.</span>
          </label>
          <label className={labelClass}>
            <span className="flex items-center gap-2">When a page rule is broken {src("ruleEnforcement")}</span>
            <select value={draft.ruleEnforcement} onChange={(e) => set({ ruleEnforcement: e.target.value as ProfileDraft["ruleEnforcement"] })} className={`${inputClass} w-56`}>
              <option value="">Inherit{inherited ? ` (${inherited.ruleEnforcement === "BLOCK" ? "block" : "warn"})` : ""}</option>
              <option value="WARN">Warn the editor and approver</option>
              <option value="BLOCK">Block submission and scheduling</option>
            </select>
          </label>
        </div>
      </fieldset>
    </div>
  );
}
