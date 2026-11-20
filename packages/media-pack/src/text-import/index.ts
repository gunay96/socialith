import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { parseCsv, type CsvDelimiter } from "./csv.js";
import { decodeTextBytes, type TextEncoding } from "./decode.js";
import { TextImportError } from "./errors.js";
import { interpretTable, type ColumnMap, type ImportRow, type TableOptions } from "./table.js";
import { parseTxt, type TxtSplit } from "./txt.js";
import { readXlsx } from "./xlsx.js";

export { TextImportError, type TextImportErrorCode } from "./errors.js";
export { decodeTextBytes, type TextEncoding } from "./decode.js";
export { detectDelimiter, parseCsv, type CsvDelimiter } from "./csv.js";
export { parseTxt, type TxtSplit } from "./txt.js";
export { columnIndex, readXlsx, type XlsxTable } from "./xlsx.js";
export { interpretTable, matchHeader, type ColumnMap, type ImportRow, type InterpretedTable, type TableOptions } from "./table.js";

export type TextImportFormat = "TXT" | "CSV" | "XLSX";

export interface ParseTextImportOptions extends TableOptions {
  maxRows: number;
  maxBytes: number;
  /** TXT only. */
  split?: TxtSplit | "auto";
  /** CSV only. */
  delimiter?: CsvDelimiter;
  /** XLSX only: a sheet name. */
  sheet?: string;
}

export interface ParsedTextImport {
  format: TextImportFormat;
  encoding: TextEncoding | null;
  delimiter: CsvDelimiter | null;
  split: TxtSplit | null;
  sheetName: string | null;
  sheetNames: string[] | null;
  header: string[] | null;
  columns: ColumnMap | null;
  rows: ImportRow[];
  emptyRows: number;
}

const FORMATS: Record<string, TextImportFormat> = { ".txt": "TXT", ".csv": "CSV", ".xlsx": "XLSX" };
export const formatForFileName = (fileName: string): TextImportFormat | null => FORMATS[extname(fileName).toLowerCase()] ?? null;

/**
 * Reads a TXT, CSV or XLSX file from disk into import rows. Never throws anything but TextImportError for a bad file.
 * Row-level problems (empty, too long, duplicates) are judged later, per row; this only decides what the rows are.
 */
export async function parseTextImport(path: string, fileName: string, options: ParseTextImportOptions): Promise<ParsedTextImport> {
  const format = formatForFileName(fileName);
  if (!format) throw new TextImportError("NOT_TEXT", "Only .txt, .csv and .xlsx files can be imported.");
  const { size } = await stat(path);
  if (size === 0) throw new TextImportError("EMPTY_FILE", "The file is empty.");
  if (size > options.maxBytes) throw new TextImportError("TOO_MANY_ROWS", `The file is ${size} bytes; the import limit is ${options.maxBytes}. Split it into smaller files.`);

  if (format === "XLSX") {
    const sheet = await readXlsx(path, { maxRows: options.maxRows, ...(options.sheet ? { sheet: options.sheet } : {}) });
    const table = interpretTable(sheet.rows, { ...options, rowNumbers: sheet.rowNumbers });
    return { format, encoding: null, delimiter: null, split: null, sheetName: sheet.sheetName, sheetNames: sheet.sheetNames, header: table.header, columns: table.columns, rows: table.rows, emptyRows: table.emptyRows };
  }

  const { text, encoding } = decodeTextBytes(await readFile(path));
  if (format === "TXT") {
    const parsed = parseTxt(text, { maxRows: options.maxRows, ...(options.split ? { split: options.split } : {}) });
    const rows: ImportRow[] = parsed.texts.map((t, i) => ({ rowNumber: parsed.startLines[i]!, text: t, category: null, language: null, source: null, author: null, notes: null }));
    return { format, encoding, delimiter: null, split: parsed.split, sheetName: null, sheetNames: null, header: null, columns: null, rows, emptyRows: 0 };
  }
  const csv = parseCsv(text, { maxRows: options.maxRows, ...(options.delimiter ? { delimiter: options.delimiter } : {}) });
  const table = interpretTable(csv.rows, options);
  return { format, encoding, delimiter: csv.delimiter, split: null, sheetName: null, sheetNames: null, header: table.header, columns: table.columns, rows: table.rows, emptyRows: table.emptyRows };
}
