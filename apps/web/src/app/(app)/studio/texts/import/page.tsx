"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { COMMON_LANGUAGES } from "@socialith/studio";
import { ApiError, apiUpload } from "@/lib/api";
import { formatBytes, useStudioRole } from "@/lib/studio";
import { ChipPicker, useNetworkOptions, type ImportReport, type ImportRowReport, type TextCategory } from "@/lib/texts";
import { Banner, Card, Chip, TONES, inputClass, useFetch } from "@/lib/upload-post";

const ACCEPT = ".txt,.csv,.xlsx";
const ROW_TONE: Record<ImportRowReport["status"], string> = { NEW: TONES.GREEN, DUPLICATE_LIBRARY: TONES.AMBER, DUPLICATE_FILE: TONES.AMBER, INVALID: TONES.RED };
const ROW_LABEL: Record<ImportRowReport["status"], string> = { NEW: "new", DUPLICATE_LIBRARY: "already in library", DUPLICATE_FILE: "repeated in file", INVALID: "cannot import" };

export default function TextImportPage() {
  const { canEdit, isAdmin } = useStudioRole();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [language, setLanguage] = useState("");
  const [sourceNote, setSourceNote] = useState("");
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [pageCategoryIds, setPageCategoryIds] = useState<string[]>([]);
  const [pageGroupIds, setPageGroupIds] = useState<string[]>([]);
  const [createMissing, setCreateMissing] = useState(false);
  const [split, setSplit] = useState("auto");
  const [textColumn, setTextColumn] = useState("");
  const [sheet, setSheet] = useState("");
  const [busy, setBusy] = useState<"check" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const categories = useFetch<{ items: TextCategory[] }>("/api/text-library/categories");
  const network = useNetworkOptions();

  if (!canEdit) return <Banner tone="info">Importing needs the editor role or above. You can browse the library.</Banner>;

  const ext = file ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "";
  const options = (dryRun: boolean) => ({
    dryRun,
    language: language || null,
    sourceNote: sourceNote || null,
    categoryIds,
    pageCategoryIds,
    pageGroupIds,
    createMissingCategories: createMissing,
    split,
    ...(textColumn.trim() ? { textColumn: /^\d+$/.test(textColumn.trim()) ? Number(textColumn.trim()) : textColumn.trim() } : {}),
    ...(sheet.trim() ? { sheet: sheet.trim() } : {}),
  });

  function choose(files: FileList | null) {
    const f = files?.[0] ?? null;
    setFile(f);
    setReport(null);
    setError(null);
  }

  async function send(dryRun: boolean) {
    if (!file) return;
    setBusy(dryRun ? "check" : "import");
    setError(null);
    try {
      const form = new FormData();
      form.append("options", JSON.stringify(options(dryRun)));
      form.append("file", file);
      setReport(await apiUpload<ImportReport>("/api/text-library/imports", form));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The file could not be sent.");
      if (!dryRun) setReport(null);
    } finally {
      setBusy(null);
    }
  }

  const t = report?.totals;
  return (
    <div className="flex max-w-4xl min-w-0 flex-col gap-4">
      <Link href="/studio/texts" className="text-sm text-muted hover:text-foreground">← Text Library</Link>
      <Banner tone="info">
        Import texts from a TXT file (one text per line, or paragraphs separated by blank lines), a CSV file or an Excel (.xlsx) sheet. A CSV or Excel file can have columns named text, category, language, source and author. Imported texts always start as "needs review"; nothing is approved automatically.
      </Banner>

      <div
        role="button"
        tabIndex={0}
        aria-label="Choose a file to import, or drop it here"
        onClick={() => input.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            input.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          choose(e.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded border-2 border-dashed p-8 text-center transition-colors motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${dragging ? "border-accent bg-accent/10" : "border-border hover:border-foreground/40"}`}
      >
        <span className="text-sm font-medium">{file ? file.name : "Drop a file here, or click to choose"}</span>
        <span className="text-xs text-muted">{file ? formatBytes(file.size) : "TXT · CSV · XLSX"}</span>
        <input ref={input} type="file" accept={ACCEPT} className="sr-only" tabIndex={-1} onChange={(e) => { choose(e.target.files); e.target.value = ""; }} />
      </div>

      <Card title="Options">
        <div className="flex flex-col gap-4 text-sm">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              Language of the texts
              <select value={language} onChange={(e) => setLanguage(e.target.value)} className={inputClass}>
                <option value="">Not set (a language column in the file still applies)</option>
                {COMMON_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              Source
              <input value={sourceNote} onChange={(e) => setSourceNote(e.target.value)} maxLength={255} placeholder="defaults to the file name" className={inputClass} />
            </label>
          </div>
          <ChipPicker label="Categories for texts that have none in the file" options={categories.data?.items.filter((c) => c.status === "ACTIVE") ?? []} selected={categoryIds} onChange={setCategoryIds} empty="No categories yet: an administrator can add the starter set under Categories and collections." />
          <details className="rounded border border-border p-3">
            <summary className="cursor-pointer text-sm">More options</summary>
            <div className="mt-3 flex flex-col gap-4">
              <ChipPicker label="Limit the imported texts to these page categories (none = every page)" options={network.pageCategories} selected={pageCategoryIds} onChange={setPageCategoryIds} />
              <ChipPicker label="… and to these page groups" options={network.pageGroups} selected={pageGroupIds} onChange={setPageGroupIds} />
              <div className="grid gap-4 md:grid-cols-3">
                {ext === ".txt" && (
                  <label className="flex flex-col gap-1">
                    TXT: how texts are separated
                    <select value={split} onChange={(e) => setSplit(e.target.value)} className={inputClass}>
                      <option value="auto">Detect</option>
                      <option value="LINE">One text per line</option>
                      <option value="BLANK_LINE">Blank line between texts</option>
                    </select>
                  </label>
                )}
                {(ext === ".csv" || ext === ".xlsx") && (
                  <label className="flex flex-col gap-1">
                    Text column <span className="text-xs text-muted">only if it is not named "text"</span>
                    <input value={textColumn} onChange={(e) => setTextColumn(e.target.value)} placeholder="column name" className={inputClass} />
                  </label>
                )}
                {ext === ".xlsx" && (
                  <label className="flex flex-col gap-1">
                    Sheet <span className="text-xs text-muted">the first sheet by default</span>
                    <input value={sheet} onChange={(e) => setSheet(e.target.value)} placeholder="sheet name" className={inputClass} />
                  </label>
                )}
              </div>
              {isAdmin && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />
                  Create the categories named in the file that do not exist yet
                </label>
              )}
            </div>
          </details>
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={() => void send(true)} disabled={!file || busy !== null} className="rounded bg-accent px-3 py-2 font-medium text-background disabled:opacity-40">{busy === "check" ? "Checking…" : "Check the file"}</button>
            <span className="text-xs text-muted">Checking changes nothing. You see what would happen first.</span>
          </div>
        </div>
      </Card>

      {error && <Banner tone="error">{error}</Banner>}

      {report && t && (
        <Card title={report.dryRun ? "What would happen" : "Imported"}>
          <div className="flex flex-col gap-4 text-sm">
            <p className="text-xs text-muted">
              {report.file.name} · {report.file.format} · {formatBytes(report.file.bytes)}
              {report.file.encoding === "windows-1254" ? " · read as Windows-1254 (Turkish ANSI); save as UTF-8 if letters look wrong" : ""}
              {report.file.delimiter ? ` · separator ${report.file.delimiter === "\t" ? "tab" : `"${report.file.delimiter}"`}` : ""}
              {report.file.sheetName ? ` · sheet "${report.file.sheetName}"` : ""}
              {report.file.header ? ` · columns: ${report.file.header.join(", ")}` : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              <Chip tone={TONES.GREEN}>{t.new} new</Chip>
              {t.duplicatesInLibrary > 0 && <Chip tone={TONES.AMBER}>{t.duplicatesInLibrary} already in the library</Chip>}
              {t.duplicatesInFile > 0 && <Chip tone={TONES.AMBER}>{t.duplicatesInFile} repeated in the file</Chip>}
              {t.invalid > 0 && <Chip tone={TONES.RED}>{t.invalid} cannot be imported</Chip>}
              {t.withWarnings > 0 && <Chip tone={TONES.AMBER}>{t.withWarnings} with a warning</Chip>}
              <Chip>{t.rows} rows read</Chip>
            </div>
            {report.unknownCategories.length > 0 && (
              <Banner tone="warn">
                {report.dryRun && createMissing && isAdmin ? "These categories do not exist and will be created: " : report.createdCategories?.length ? "Created categories: " : "The file names categories that do not exist, so they are not applied: "}
                {(report.createdCategories?.length ? report.createdCategories : report.unknownCategories).join(", ")}.
              </Banner>
            )}
            {!report.dryRun && (
              <Banner tone="ok">
                {report.imported} text{report.imported === 1 ? "" : "s"} imported and waiting for review. <Link href={`/studio/texts?batchId=${report.batchId}&status=PENDING`} className="underline">Open them</Link>.
              </Banner>
            )}
            {report.problems.length > 0 && (
              <div className="min-w-0 overflow-x-auto rounded border border-border">
                <table className="w-full min-w-[32rem] text-left text-xs">
                  <thead className="border-b border-border text-muted"><tr><th className="p-2 font-medium">Row</th><th className="p-2 font-medium">Result</th><th className="p-2 font-medium">Text</th><th className="p-2 font-medium">Why</th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {report.problems.slice(0, 100).map((p) => (
                      <tr key={`${p.row}-${p.status}`}>
                        <td className="p-2 tabular-nums">{p.row}</td>
                        <td className="p-2"><Chip tone={ROW_TONE[p.status]}>{ROW_LABEL[p.status]}</Chip></td>
                        <td className="max-w-xs truncate p-2" title={p.text}>{p.text || <span className="text-muted">(empty)</span>}</td>
                        <td className="p-2 text-muted">{[p.reason, ...p.warnings].filter(Boolean).join(" ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {report.problems.length > 100 && <p className="p-2 text-xs text-muted">Showing the first 100 of {report.problems.length} rows that need a look.</p>}
              </div>
            )}
            {report.dryRun && (
              <div className="flex flex-wrap items-center gap-3">
                <button onClick={() => void send(false)} disabled={busy !== null || t.new === 0} className="rounded bg-accent px-3 py-2 font-medium text-background disabled:opacity-40">{busy === "import" ? "Importing…" : `Import ${t.new} text${t.new === 1 ? "" : "s"}`}</button>
                {t.new === 0 && <span className="text-xs text-muted">There is nothing new to import in this file.</span>}
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
