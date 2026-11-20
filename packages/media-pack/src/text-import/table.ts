import { TextImportError } from "./errors.js";

export interface ImportRow {
  /** Row (or line) number in the file as the person sees it, for messages. */
  rowNumber: number;
  text: string;
  category: string | null;
  language: string | null;
  source: string | null;
  author: string | null;
  notes: string | null;
}

export interface ColumnMap {
  text: number;
  category: number | null;
  language: number | null;
  source: number | null;
  author: number | null;
  notes: number | null;
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// header names people use (English and Turkish), compared without case, accents or punctuation
const SYNONYMS: Record<keyof ColumnMap, string[]> = {
  text: ["text", "texts", "metin", "quote", "quotes", "soz", "caption", "mesaj", "message", "content", "icerik", "body"],
  category: ["category", "categories", "kategori", "cat"],
  language: ["language", "lang", "dil"],
  source: ["source", "kaynak"],
  author: ["author", "yazar", "artist", "sanatci", "attribution"],
  notes: ["notes", "note", "not", "aciklama", "comment", "comments"],
};

export function matchHeader(cell: string): keyof ColumnMap | null {
  const f = fold(cell);
  for (const key of Object.keys(SYNONYMS) as (keyof ColumnMap)[]) if (SYNONYMS[key].includes(f)) return key;
  return null;
}

export interface TableOptions {
  /** Which column holds the text: a 0-based index, or a header name. Needed only when the header is not recognised. */
  textColumn?: number | string;
  /** "auto" looks for a recognised header in the first row. */
  hasHeader?: boolean | "auto";
  /** Row numbers of `rows` as the person sees them (default: 1, 2, 3, …). */
  rowNumbers?: number[];
}

export interface InterpretedTable {
  header: string[] | null;
  columns: ColumnMap;
  rows: ImportRow[];
  /** Rows that were completely empty (not an error). */
  emptyRows: number;
}

const cellAt = (row: string[], i: number | null): string | null => (i === null ? null : (row[i] ?? "").trim() || null);

/** Finds the columns and turns the remaining rows into import rows. */
export function interpretTable(rows: string[][], options: TableOptions = {}): InterpretedTable {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  if (rows.length === 0 || width === 0) throw new TextImportError("NO_ROWS", "The file contains no rows.");
  const first = rows[0]!;
  const mapped = first.map(matchHeader);
  const recognised = mapped.includes("text");
  // naming a column by its header implies that the first row is a header
  const hasHeader = options.hasHeader === undefined || options.hasHeader === "auto" ? typeof options.textColumn === "string" || recognised || (width > 1 && mapped.some((m) => m !== null)) : options.hasHeader;

  const columns: ColumnMap = { text: -1, category: null, language: null, source: null, author: null, notes: null };
  if (hasHeader) {
    mapped.forEach((key, i) => {
      if (key && (key === "text" ? columns.text === -1 : columns[key] === null)) columns[key] = i;
    });
  }
  if (typeof options.textColumn === "number") columns.text = options.textColumn;
  else if (typeof options.textColumn === "string" && hasHeader) {
    const wanted = fold(options.textColumn);
    const at = first.findIndex((h) => fold(h) === wanted);
    if (at === -1) throw new TextImportError("NO_TEXT_COLUMN", `There is no column named "${options.textColumn}". Columns: ${first.map((h) => `"${h}"`).join(", ")}.`);
    columns.text = at;
  }
  if (columns.text === -1) {
    if (width === 1) columns.text = 0;
    else {
      const names = hasHeader ? first.map((h) => `"${h}"`).join(", ") : `${width} columns without a header`;
      throw new TextImportError("NO_TEXT_COLUMN", `Could not tell which column holds the text (${names}). Name the column "text" in the first row, or choose the text column.`);
    }
  }

  const start = hasHeader ? 1 : 0;
  const out: ImportRow[] = [];
  let emptyRows = 0;
  for (let i = start; i < rows.length; i++) {
    const row = rows[i]!;
    const text = (row[columns.text] ?? "").trim();
    if (text === "" && row.every((c) => c.trim() === "")) {
      emptyRows++;
      continue;
    }
    out.push({
      rowNumber: options.rowNumbers?.[i] ?? i + 1,
      text: row[columns.text] ?? "",
      category: cellAt(row, columns.category),
      language: cellAt(row, columns.language),
      source: cellAt(row, columns.source),
      author: cellAt(row, columns.author),
      notes: cellAt(row, columns.notes),
    });
  }
  if (out.length === 0) throw new TextImportError("NO_ROWS", "The file has a header but no texts under it.");
  return { header: hasHeader ? first : null, columns, rows: out, emptyRows };
}
