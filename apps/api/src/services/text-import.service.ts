import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import multer from "multer";
import type { Request, RequestHandler } from "express";
import { loadEnv } from "@socialith/config";
import { prisma } from "@socialith/database";
import type { Prisma, TextSource } from "@socialith/database";
import { HEAD_BYTES, TextImportError, detectSignature, looksLikeLegacyText, parseTextImport, readHead, sha256File, validateUpload, type ParsedTextImport } from "@socialith/media-pack";
import { LANGUAGE_PATTERN, checkText, cleanText, describeTextProblem, normalizeForSearch, textLength } from "@socialith/studio";
import { ERROR_CODES } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import type { SafeUser } from "../types/auth.js";
import { importOptionsSchema, type ImportOptions } from "../validation/text.validation.js";
import { UPLOAD_TMP_DIR } from "./media-upload.service.js";
import { assertOwned, requireAdmin } from "./text-library.service.js";
import { duplicateHash, searchForm, slugify } from "./text-common.js";

/**
 * Text import: a TXT, CSV or XLSX file becomes texts in the library. The file is streamed to disk, checked by signature
 * as well as by name, parsed with hard limits (rows, bytes, spreadsheet inflation), and judged row by row:
 *   NEW                an unknown text: imported, PENDING approval (an import never approves anything)
 *   DUPLICATE_LIBRARY  the same text (ignoring case, spacing, punctuation and the Turkish i) is already in the library
 *   DUPLICATE_FILE     the same text appears earlier in this file
 *   INVALID            empty, or longer than the text limit
 * "dryRun" reports all of this and changes nothing; the same request with dryRun=false imports the NEW rows.
 */

const env = loadEnv();
const limits = { maxRows: env.TEXT_IMPORT_MAX_ROWS, maxBytes: env.TEXT_IMPORT_MAX_BYTES };
const ACCEPTED = [".txt", ".csv", ".xlsx"];
const rejectedByFilter = new WeakMap<Request, string>();

const uploader = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
      cb(null, UPLOAD_TMP_DIR);
    },
    filename: (_req, _file, cb) => cb(null, `${randomUUID()}.import`),
  }),
  limits: { fileSize: limits.maxBytes, files: 1, fields: 4, fieldSize: 16 * 1024 },
  fileFilter(req, file, cb) {
    if (!ACCEPTED.some((ext) => file.originalname.toLowerCase().endsWith(ext))) {
      rejectedByFilter.set(req, `"${file.originalname}" cannot be imported. Accepted: ${ACCEPTED.join(", ")}.`);
      cb(null, false);
      return;
    }
    cb(null, true);
  },
}).single("file");

const bad = (message: string, details?: unknown, status = 400) => new ApiHttpError(status, ERROR_CODES.INVALID_REQUEST, message, details);

export const textImportUpload: RequestHandler = (req, res, next) => {
  uploader(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") return next(bad(`The file is larger than the import limit (${limits.maxBytes} bytes). Split it into smaller files.`, { code: "FILE_TOO_LARGE" }, 413));
      return next(bad(`The upload was not accepted (${err.code}).`, { code: err.code }));
    }
    next(err);
  });
};

export type RowStatus = "NEW" | "DUPLICATE_LIBRARY" | "DUPLICATE_FILE" | "INVALID";

export interface RowReport {
  row: number;
  status: RowStatus;
  text: string;
  reason?: string;
  duplicateOf?: { id?: string; row?: number; status?: string };
  categories: string[];
  language: string | null;
  warnings: string[];
}

interface PlannedRow {
  report: RowReport;
  source: ParsedTextImport["rows"][number];
  body: string;
  hash: string;
  categoryIds: string[];
}

const split = (cell: string): string[] => cell.split(/[;|,]/).map((s) => s.trim()).filter(Boolean);
const fold = (s: string) => normalizeForSearch(s);

export async function handleTextImport(actor: SafeUser, req: Request) {
  const file = req.file;
  try {
    if (!file) throw bad(rejectedByFilter.get(req) ?? 'No file was sent. Send the file in a multipart field named "file".');
    const options = parseOptions(req.body);
    if (options.createMissingCategories) requireAdmin(actor, "Creating categories from an import");

    const { size } = await stat(file.path);
    const head = await readHead(file.path, HEAD_BYTES);
    // a TXT/CSV saved by older Excel or Notepad is Windows-1254 ("Turkish ANSI"), not UTF-8: accepted here and decoded explicitly
    const legacyText = /\.(txt|csv)$/i.test(file.originalname) && detectSignature(head) === null && looksLikeLegacyText(head);
    if (!legacyText) {
      const check = validateUpload(file.originalname, file.mimetype, head);
      if (!check.ok) throw bad(check.message, { code: check.code });
    }

    let parsed: ParsedTextImport;
    try {
      parsed = await parseTextImport(file.path, file.originalname, { ...limits, split: options.split, hasHeader: options.hasHeader, ...(options.textColumn !== undefined ? { textColumn: options.textColumn } : {}), ...(options.delimiter ? { delimiter: options.delimiter } : {}), ...(options.sheet ? { sheet: options.sheet } : {}) });
    } catch (err) {
      if (err instanceof TextImportError) throw bad(err.message, { code: err.code }, err.code === "TOO_MANY_ROWS" ? 413 : 400);
      throw err;
    }

    const org = actor.organizationId;
    await Promise.all([
      assertOwned("categories", org, options.categoryIds),
      assertOwned("campaigns", org, options.campaignIds),
      assertOwned("pageCategories", org, options.pageCategoryIds),
      assertOwned("pageGroups", org, options.pageGroupIds),
      assertOwned("pages", org, options.pageIds),
    ]);

    const categories = await prisma.textCategory.findMany({ where: { organizationId: org, status: "ACTIVE" }, select: { id: true, name: true } });
    const categoryByName = new Map(categories.map((c) => [fold(c.name), c.id]));
    const plan = await planRows(org, parsed, options, categoryByName);
    const unknownCategories = [...new Set(plan.flatMap((p) => p.unknown))];
    const rows = plan.map((p) => p.row);

    const totals = {
      rows: rows.length,
      new: rows.filter((r) => r.report.status === "NEW").length,
      duplicatesInLibrary: rows.filter((r) => r.report.status === "DUPLICATE_LIBRARY").length,
      duplicatesInFile: rows.filter((r) => r.report.status === "DUPLICATE_FILE").length,
      invalid: rows.filter((r) => r.report.status === "INVALID").length,
      withWarnings: rows.filter((r) => r.report.warnings.length > 0).length,
      emptyRowsSkipped: parsed.emptyRows,
    };
    const fileInfo = { name: file.originalname, format: parsed.format, bytes: size, encoding: parsed.encoding, delimiter: parsed.delimiter, split: parsed.split, sheetName: parsed.sheetName, sheetNames: parsed.sheetNames, header: parsed.header, columns: parsed.columns };
    const problems = rows.filter((r) => r.report.status !== "NEW" || r.report.warnings.length > 0).slice(0, 200).map((r) => r.report);
    const sample = rows.slice(0, 50).map((r) => r.report);

    if (options.dryRun) return { dryRun: true as const, file: fileInfo, totals, unknownCategories, willCreateCategories: options.createMissingCategories ? unknownCategories : [], sample, problems };

    const sha = await sha256File(file.path);
    const result = await commit(actor, file.originalname, parsed, size, sha, options, rows, unknownCategories, categoryByName);
    await createAuditLog({ organizationId: org, userId: actor.id, action: "TEXT_IMPORTED", targetType: "TextImportBatch", targetId: result.batchId, metadata: { fileName: file.originalname, format: parsed.format, ...totals, imported: result.imported } });
    return { dryRun: false as const, file: fileInfo, totals, unknownCategories, createdCategories: result.createdCategories, imported: result.imported, batchId: result.batchId, problems };
  } finally {
    if (file) await rm(file.path, { force: true }).catch(() => undefined);
  }
}

function parseOptions(body: unknown): ImportOptions {
  const raw = (body as Record<string, unknown> | undefined)?.options;
  let value: unknown = {};
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw bad('The "options" field is not valid JSON.');
    }
  }
  const parsed = importOptionsSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw bad(`Invalid import options${first ? `: ${first.path.join(".") || "input"} ${first.message}` : "."}`);
  }
  return parsed.data;
}

async function planRows(organizationId: string, parsed: ParsedTextImport, options: ImportOptions, categoryByName: Map<string, string>): Promise<{ row: PlannedRow; unknown: string[] }[]> {
  const prepared = parsed.rows.map((source) => {
    const body = cleanText(source.text);
    return { source, body, problem: checkText(body), hash: duplicateHash(body) };
  });
  // which of the file's texts are already in the library
  const known = new Map<string, { id: string; status: string }>();
  const hashes = [...new Set(prepared.filter((p) => !p.problem).map((p) => p.hash))];
  for (let i = 0; i < hashes.length; i += 1000) {
    const found = await prisma.textEntry.findMany({ where: { organizationId, normalizedHash: { in: hashes.slice(i, i + 1000) } }, select: { id: true, normalizedHash: true, approvalStatus: true } });
    for (const f of found) known.set(f.normalizedHash, { id: f.id, status: f.approvalStatus });
  }
  const firstInFile = new Map<string, number>();
  return prepared.map(({ source, body, problem, hash }) => {
    const warnings: string[] = [];
    const unknown: string[] = [];
    const categoryIds: string[] = [];
    const categoryNames: string[] = [];
    if (source.category) {
      for (const name of split(source.category)) {
        const id = categoryByName.get(fold(name));
        if (id) {
          categoryIds.push(id);
          categoryNames.push(name);
        } else {
          unknown.push(name);
          if (!options.createMissingCategories) warnings.push(`Unknown category "${name}": not applied.`);
        }
      }
    }
    let language = options.language ?? null;
    if (source.language) {
      const l = source.language.trim().toLowerCase();
      if (LANGUAGE_PATTERN.test(l) && l.length <= 16) language = l;
      else warnings.push(`Language "${source.language}" is not a language code (such as tr or en): ignored.`);
    }
    const base = { row: source.rowNumber, text: body.length > 160 ? `${[...body].slice(0, 160).join("")}…` : body, categories: categoryNames, language, warnings };
    let report: RowReport;
    if (problem) report = { ...base, status: "INVALID", reason: describeTextProblem(problem) };
    else if (known.has(hash)) report = { ...base, status: "DUPLICATE_LIBRARY", reason: known.get(hash)!.status === "ARCHIVED" ? "Already in the library (archived)." : "Already in the library.", duplicateOf: { id: known.get(hash)!.id, status: known.get(hash)!.status } };
    else if (firstInFile.has(hash)) report = { ...base, status: "DUPLICATE_FILE", reason: `Same text as row ${firstInFile.get(hash)} of this file.`, duplicateOf: { row: firstInFile.get(hash)! } };
    else {
      firstInFile.set(hash, source.rowNumber);
      report = { ...base, status: "NEW" };
    }
    return { row: { report, source, body, hash, categoryIds }, unknown };
  });
}

const SOURCE: Record<string, TextSource> = { TXT: "TXT", CSV: "CSV", XLSX: "XLSX" };

async function commit(actor: SafeUser, fileName: string, parsed: ParsedTextImport, size: number, sha256: string, options: ImportOptions, rows: PlannedRow[], unknownCategories: string[], categoryByName: Map<string, string>) {
  const org = actor.organizationId;
  const fresh = rows.filter((r) => r.report.status === "NEW");
  return prisma.$transaction(
    async (tx) => {
      const createdCategories: string[] = [];
      if (options.createMissingCategories) {
        for (const name of unknownCategories) {
          if (categoryByName.has(fold(name))) continue;
          const taken = new Set((await tx.textCategory.findMany({ where: { organizationId: org }, select: { slug: true } })).map((c) => c.slug));
          let slug = slugify(name);
          for (let n = 2; taken.has(slug); n++) slug = `${slugify(name)}-${n}`;
          const row = await tx.textCategory.create({ data: { organizationId: org, name: name.slice(0, 80), slug, createdById: actor.id } });
          categoryByName.set(fold(name), row.id);
          createdCategories.push(row.name);
        }
        for (const r of fresh) for (const name of split(r.source.category ?? "")) {
          const id = categoryByName.get(fold(name));
          if (id && !r.categoryIds.includes(id)) r.categoryIds.push(id);
        }
      }
      const batch = await tx.textImportBatch.create({
        data: {
          organizationId: org,
          fileName: fileName.slice(0, 255),
          format: SOURCE[parsed.format]!,
          fileBytes: size,
          contentSha256: sha256,
          totalRows: rows.length,
          importedCount: 0,
          duplicateCount: rows.filter((r) => r.report.status === "DUPLICATE_LIBRARY" || r.report.status === "DUPLICATE_FILE").length,
          invalidCount: rows.filter((r) => r.report.status === "INVALID").length,
          options: { language: options.language, sourceNote: options.sourceNote, categoryIds: options.categoryIds, createMissingCategories: options.createMissingCategories } as Prisma.InputJsonValue,
          problems: rows.filter((r) => r.report.status !== "NEW").slice(0, 200).map((r) => ({ row: r.report.row, status: r.report.status, reason: r.report.reason })) as Prisma.InputJsonValue,
          createdById: actor.id,
        },
      });

      for (let i = 0; i < fresh.length; i += 500) {
        await tx.textEntry.createMany({
          data: fresh.slice(i, i + 500).map((r) => ({
            organizationId: org,
            body: r.body,
            normalizedHash: r.hash,
            searchText: searchForm(r.body),
            charCount: textLength(r.body),
            language: r.report.language,
            source: SOURCE[parsed.format]!,
            sourceNote: (r.source.source ?? options.sourceNote ?? fileName).slice(0, 255),
            sourceRow: r.source.rowNumber,
            importBatchId: batch.id,
            author: r.source.author ? r.source.author.slice(0, 255) : null,
            notes: r.source.notes,
            createdById: actor.id,
          })),
          skipDuplicates: true,
        });
      }
      const created = await tx.textEntry.findMany({ where: { organizationId: org, importBatchId: batch.id }, select: { id: true, normalizedHash: true } });
      const idByHash = new Map(created.map((c) => [c.normalizedHash, c.id]));
      const pairs = <T>(make: (textId: string, targetId: string) => T, perRow: (r: PlannedRow) => string[]): T[] =>
        fresh.flatMap((r) => {
          const textId = idByHash.get(r.hash);
          return textId ? [...new Set(perRow(r))].map((t) => make(textId, t)) : [];
        });
      const defaultCategories = (r: PlannedRow) => (r.categoryIds.length ? r.categoryIds : options.categoryIds);
      const links = [
        { rows: pairs((textId, categoryId) => ({ textId, categoryId }), defaultCategories), run: (data: { textId: string; categoryId: string }[]) => tx.textEntryCategory.createMany({ data, skipDuplicates: true }) },
        { rows: pairs((textId, campaignId) => ({ textId, campaignId }), () => options.campaignIds), run: (data: { textId: string; campaignId: string }[]) => tx.textEntryCampaign.createMany({ data, skipDuplicates: true }) },
        { rows: pairs((textId, categoryId) => ({ textId, categoryId }), () => options.pageCategoryIds), run: (data: { textId: string; categoryId: string }[]) => tx.textEntryPageCategory.createMany({ data, skipDuplicates: true }) },
        { rows: pairs((textId, groupId) => ({ textId, groupId }), () => options.pageGroupIds), run: (data: { textId: string; groupId: string }[]) => tx.textEntryPageGroup.createMany({ data, skipDuplicates: true }) },
        { rows: pairs((textId, pageId) => ({ textId, pageId }), () => options.pageIds), run: (data: { textId: string; pageId: string }[]) => tx.textEntryPage.createMany({ data, skipDuplicates: true }) },
      ];
      for (const l of links) {
        // each kind is a different table, so the typed `run` closes over the right one
        for (let i = 0; i < l.rows.length; i += 1000) await (l.run as (d: unknown[]) => Promise<unknown>)(l.rows.slice(i, i + 1000));
      }
      await tx.textImportBatch.update({ where: { id: batch.id }, data: { importedCount: created.length } });
      return { batchId: batch.id, imported: created.length, createdCategories };
    },
    { timeout: 120_000, maxWait: 20_000 },
  );
}
