import { TextImportError } from "./errors.js";

const DELIMITERS = [",", ";", "\t", "|"] as const;
export type CsvDelimiter = (typeof DELIMITERS)[number];

/** The delimiter used by the first non-empty line (outside quotes). Excel in some locales (Turkish, German) writes ";". */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) {
      if ([...counts.values()].some((n) => n > 0)) break;
    } else if (!quoted && counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best: CsvDelimiter = ",";
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const n = counts.get(d) ?? 0;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/**
 * RFC 4180 CSV: quoted fields, doubled quotes, delimiters and line breaks inside quotes, LF/CRLF/CR line ends.
 * Stops with TOO_MANY_ROWS as soon as the limit is passed (a file is refused, never silently cut short).
 */
export function parseCsv(text: string, options: { maxRows: number; delimiter?: CsvDelimiter }): { rows: string[][]; delimiter: CsvDelimiter } {
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;

  const endField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    if (rows.length > options.maxRows + 1) throw new TextImportError("TOO_MANY_ROWS", `The file has more than ${options.maxRows} rows. Split it into smaller files.`);
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (ch === delimiter) endField();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  // the last line without a trailing line break
  if (field !== "" || row.length > 0 || quoted) endRow();
  return { rows, delimiter };
}
