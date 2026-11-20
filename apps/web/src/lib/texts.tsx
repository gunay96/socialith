"use client";

import { useCallback, useState } from "react";
import { ApiError } from "@/lib/api";
import { Chip, TONES, useFetch } from "@/lib/upload-post";

// ------------------------------------------------------------------------------------------------ API shapes

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "ARCHIVED";
export type RightsStatus = "UNVERIFIED" | "CONFIRMED" | "RESTRICTED";

export interface Named { id: string; name: string }

export interface TextDto {
  id: string;
  text: string;
  charCount: number;
  language: string | null;
  source: "MANUAL" | "TXT" | "CSV" | "XLSX";
  sourceNote: string | null;
  sourceRow: number | null;
  importBatchId: string | null;
  author: string | null;
  rights: { status: RightsStatus; notes: string | null };
  approval: { status: ApprovalStatus; approvedAt: string | null; approvedById: string | null; reviewNote: string | null };
  notes: string | null;
  categories: Named[];
  campaigns: Named[];
  pageCategories: Named[];
  pages: (Named & { platform: string | null; username: string | null })[];
  pageGroups: Named[];
  collections: Named[];
  appliesToAllPages: boolean;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface UsageItem {
  id: string;
  kind: "MANUAL" | "PUBLICATION" | "RENDER";
  usedAt: string;
  note: string | null;
  page: Named | null;
  campaign: Named | null;
  recipe: Named | null;
  mediaAsset: Named | null;
  contentId: string | null;
}

export interface TextDetail extends TextDto {
  importBatch: { id: string; fileName: string; createdAt: string } | null;
  recentUsages: UsageItem[];
  lastUsedAt: string | null;
}

export interface TextCategory { id: string; name: string; slug: string; description: string | null; status: "ACTIVE" | "ARCHIVED"; textCount: number }
export interface TextCollection { id: string; name: string; description: string | null; status: "ACTIVE" | "ARCHIVED"; itemCount: number }

export interface TextSummary {
  status: Record<ApprovalStatus, number>;
  active: number;
  languages: { language: string | null; count: number }[];
  uncategorized: number;
  approvedUnused: number;
}

export interface ImportRowReport { row: number; status: "NEW" | "DUPLICATE_LIBRARY" | "DUPLICATE_FILE" | "INVALID"; text: string; reason?: string; categories: string[]; language: string | null; warnings: string[] }
export interface ImportReport {
  dryRun: boolean;
  file: { name: string; format: "TXT" | "CSV" | "XLSX"; bytes: number; encoding: string | null; delimiter: string | null; split: string | null; sheetName: string | null; sheetNames: string[] | null; header: string[] | null };
  totals: { rows: number; new: number; duplicatesInLibrary: number; duplicatesInFile: number; invalid: number; withWarnings: number; emptyRowsSkipped: number };
  unknownCategories: string[];
  willCreateCategories?: string[];
  createdCategories?: string[];
  imported?: number;
  batchId?: string;
  sample?: ImportRowReport[];
  problems: ImportRowReport[];
}

// ------------------------------------------------------------------------------------------------ presentation

const APPROVAL_TONE: Record<ApprovalStatus, string> = { PENDING: TONES.AMBER, APPROVED: TONES.GREEN, REJECTED: TONES.RED, ARCHIVED: TONES.NEUTRAL };
const APPROVAL_LABEL: Record<ApprovalStatus, string> = { PENDING: "needs review", APPROVED: "approved", REJECTED: "rejected", ARCHIVED: "archived" };

export function ApprovalChip({ status }: { status: ApprovalStatus }) {
  return <Chip tone={APPROVAL_TONE[status]}>{APPROVAL_LABEL[status]}</Chip>;
}

export function RightsChip({ status }: { status: RightsStatus }) {
  if (status === "CONFIRMED") return <Chip tone={TONES.GREEN}>rights confirmed</Chip>;
  if (status === "RESTRICTED") return <Chip tone={TONES.RED}>do not use</Chip>;
  return <Chip>rights not verified</Chip>;
}

export const SOURCE_LABEL: Record<TextDto["source"], string> = { MANUAL: "typed in", TXT: "TXT file", CSV: "CSV file", XLSX: "Excel file" };

export function languageLabel(code: string | null): string {
  return code ? code.toUpperCase() : "—";
}

// ------------------------------------------------------------------------------------------------ hooks

/** Runs an action and keeps one message to show: the server's own words on failure, a short confirmation on success. */
export function useAction() {
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(okText: string | ((result: T) => string), fn: () => Promise<T>): Promise<T | undefined> => {
    setMessage(null);
    setBusy(true);
    try {
      const result = await fn();
      setMessage({ tone: "ok", text: typeof okText === "function" ? okText(result) : okText });
      return result;
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Something went wrong." });
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { message, setMessage, busy, run };
}

/** What a text or a recipe can be limited to, from the existing Page Network and Campaigns. */
export function useNetworkOptions() {
  const campaigns = useFetch<{ items: Named[] }>("/api/campaigns?pageSize=100");
  const categories = useFetch<{ items: Named[] }>("/api/page-network/categories");
  const groups = useFetch<{ items: Named[] }>("/api/page-network/groups");
  const pages = useFetch<{ items: (Named & { platform?: string | null; username?: string | null })[] }>("/api/page-network/pages?pageSize=100");
  return {
    campaigns: campaigns.data?.items ?? [],
    pageCategories: categories.data?.items ?? [],
    pageGroups: groups.data?.items ?? [],
    pages: pages.data?.items ?? [],
    loading: campaigns.loading || categories.loading || groups.loading || pages.loading,
  };
}

/** A set of checkable choices (checkboxes as chips). */
export function ChipPicker({ label, options, selected, onChange, disabled, empty }: { label: string; options: { id: string; name: string }[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean; empty?: string }) {
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-1 text-xs text-muted">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.length === 0 && <span className="text-sm text-muted">{empty ?? "None yet."}</span>}
        {options.map((o) => {
          const on = selected.includes(o.id);
          return (
            <label key={o.id} className={`flex cursor-pointer items-center gap-2 rounded border px-2 py-1 text-xs transition-colors motion-reduce:transition-none ${on ? "border-accent bg-accent/10" : "border-border"} ${disabled ? "cursor-default opacity-70" : ""}`}>
              <input type="checkbox" checked={on} onChange={() => onChange(on ? selected.filter((s) => s !== o.id) : [...selected, o.id])} />
              {o.name}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
