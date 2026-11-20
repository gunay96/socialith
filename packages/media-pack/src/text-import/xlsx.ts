import type yauzl from "yauzl";
import { XMLParser } from "fast-xml-parser";
import { MIN_RATIO_CHECK_BYTES } from "../limits.js";
import { ZipLimitError, nextEntry, openZip } from "../zip.js";
import { TextImportError } from "./errors.js";

/**
 * Reads the cells of one worksheet of an .xlsx workbook as text, without any spreadsheet engine: an .xlsx is a ZIP of
 * XML parts. Safety rules, because the file comes from a person's computer:
 *   - only a handful of named parts are read (workbook, its relationships, shared strings, ONE worksheet); nothing is
 *     ever written to disk and no archive path is used as a file path
 *   - every part is bounded on the bytes that actually come out of the inflater (a lying header cannot get around it),
 *     with a total budget and a ratio check
 *   - encrypted entries, DOCTYPE/ENTITY declarations (XML entity bombs) and absurd entry counts are refused
 *   - formulas are never evaluated: the cached result the file stores is read, as text
 */
const MAX_ENTRIES = 500;
const MAX_PART_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_RATIO = 200;
const MAX_COLUMNS = 256;

export interface XlsxOptions {
  maxRows: number;
  /** A sheet name; the first worksheet when omitted. */
  sheet?: string;
}

export interface XlsxTable {
  sheetName: string;
  sheetNames: string[];
  /** Rows in file order, each cell as text ("" when empty). */
  rows: string[][];
  /** The 1-based row number of each entry of `rows` as the spreadsheet shows it. */
  rowNumbers: number[];
}

const unsafe = (message: string) => new TextImportError("XLSX_UNSAFE", message);
const invalid = (message: string) => new TextImportError("XLSX_INVALID", message);

function readPart(zip: yauzl.ZipFile, entry: yauzl.Entry, budget: { left: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(invalid(`The workbook part "${entry.fileName}" could not be read.`));
        return;
      }
      const chunks: Buffer[] = [];
      let count = 0;
      stream.on("data", (chunk: Buffer) => {
        count += chunk.length;
        budget.left -= chunk.length;
        if (count > MAX_PART_BYTES || budget.left < 0 || (count > MIN_RATIO_CHECK_BYTES && count / Math.max(1, entry.compressedSize) > MAX_RATIO)) {
          stream.destroy();
          reject(unsafe("The workbook expands to far more data than a normal spreadsheet and was refused."));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", (e) => reject(invalid(`The workbook is damaged (${e.message}).`)));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  isArray: (name) => name === "row" || name === "c" || name === "si" || name === "r" || name === "sheet" || name === "Relationship",
});

function parseXml(buffer: Buffer, what: string): Record<string, unknown> {
  const xml = buffer.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw unsafe(`The workbook's ${what} contains XML entity declarations, which a real spreadsheet never needs. It was refused.`);
  try {
    return parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw invalid(`The workbook's ${what} is not valid XML.`);
  }
}

type Node = Record<string, unknown>;
const asNode = (v: unknown): Node => (v && typeof v === "object" ? (v as Node) : {});
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** The text of a node that is a string, a number, or an element with attributes and a text node. */
function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v && typeof v === "object") {
    const t = (v as Node)["#text"];
    return typeof t === "string" ? t : typeof t === "number" ? String(t) : "";
  }
  return "";
}

/** A shared/inline string item: plain <t>, or rich text made of several <r><t> runs. */
function stringItemText(si: unknown): string {
  const node = asNode(si);
  if (node.t !== undefined) return textOf(node.t);
  return asList(node.r)
    .map((run) => textOf(asNode(run).t))
    .join("");
}

/** "B3" -> 1; "AA10" -> 26. */
export function columnIndex(cellRef: string): number {
  const letters = /^[A-Za-z]+/.exec(cellRef)?.[0].toUpperCase() ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function readXlsx(path: string, options: XlsxOptions): Promise<XlsxTable> {
  let zip: yauzl.ZipFile;
  try {
    zip = await openZip(path);
  } catch {
    throw invalid("This is not a readable .xlsx workbook.");
  }
  try {
    if (zip.entryCount > MAX_ENTRIES) throw unsafe(`The workbook declares ${zip.entryCount} parts; a spreadsheet has far fewer. It was refused.`);
    const entries = new Map<string, yauzl.Entry>();
    try {
      for (let e = await nextEntry(zip); e; e = await nextEntry(zip)) {
        if (e.isEncrypted()) throw unsafe("Encrypted or password-protected workbooks cannot be imported. Save an unprotected copy.");
        entries.set(e.fileName, e);
      }
    } catch (err) {
      if (err instanceof TextImportError) throw err;
      if (err instanceof ZipLimitError) throw err.code === "ZIP_UNSAFE_PATH" ? unsafe("The workbook contains an unsafe path and was refused.") : invalid("This is not a readable .xlsx workbook.");
      throw err;
    }
    const budget = { left: MAX_TOTAL_BYTES };
    const need = (name: string): yauzl.Entry => {
      const entry = entries.get(name);
      if (!entry) throw invalid(`This does not look like an Excel workbook (the part "${name}" is missing).`);
      return entry;
    };

    const workbook = parseXml(await readPart(zip, need("xl/workbook.xml"), budget), "workbook");
    const relsEntry = entries.get("xl/_rels/workbook.xml.rels");
    const rels = relsEntry ? parseXml(await readPart(zip, relsEntry, budget), "relationships") : {};
    const targets = new Map<string, string>();
    for (const rel of asList(asNode(rels.Relationships).Relationship)) {
      const r = asNode(rel);
      if (typeof r["@_Id"] === "string" && typeof r["@_Target"] === "string" && String(r["@_Type"] ?? "").endsWith("/worksheet")) {
        const target = r["@_Target"] as string;
        targets.set(r["@_Id"] as string, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
      }
    }
    const sheets = asList(asNode(asNode(workbook.workbook).sheets).sheet)
      .map((s) => ({ name: textOf(asNode(s)["@_name"]), id: textOf(asNode(s)["@_r:id"]) }))
      .filter((s) => s.name !== "");
    const sheetNames = sheets.map((s) => s.name);
    const chosen = options.sheet ? sheets.find((s) => s.name.toLowerCase() === options.sheet!.toLowerCase()) : sheets.find((s) => targets.has(s.id));
    if (!chosen) throw new TextImportError("XLSX_NO_SHEET", options.sheet ? `The workbook has no sheet named "${options.sheet}". Sheets: ${sheetNames.join(", ") || "none"}.` : "The workbook has no worksheet.");
    const sheetPath = targets.get(chosen.id);
    if (!sheetPath || !entries.has(sheetPath)) throw invalid(`The sheet "${chosen.name}" has no data part.`);

    const shared: string[] = [];
    const sharedEntry = entries.get("xl/sharedStrings.xml");
    if (sharedEntry) {
      const sst = asNode(parseXml(await readPart(zip, sharedEntry, budget), "shared strings").sst);
      for (const si of asList(sst.si)) shared.push(stringItemText(si));
    }

    const sheetXml = asNode(asNode(parseXml(await readPart(zip, entries.get(sheetPath)!, budget), `sheet "${chosen.name}"`).worksheet).sheetData);
    const xmlRows = asList(sheetXml.row);
    if (xmlRows.length > options.maxRows + 1) throw new TextImportError("TOO_MANY_ROWS", `The sheet has more than ${options.maxRows} rows. Split it into smaller files.`);

    const rows: string[][] = [];
    const rowNumbers: number[] = [];
    xmlRows.forEach((xmlRow, i) => {
      const row = asNode(xmlRow);
      const cells: string[] = [];
      let next = 0;
      for (const c of asList(row.c)) {
        const cell = asNode(c);
        const ref = typeof cell["@_r"] === "string" ? (cell["@_r"] as string) : "";
        const col = ref ? columnIndex(ref) : next;
        next = col + 1;
        if (col < 0 || col >= MAX_COLUMNS) continue;
        const type = typeof cell["@_t"] === "string" ? (cell["@_t"] as string) : "n";
        let value = "";
        if (type === "s") value = shared[Number(textOf(cell.v))] ?? "";
        else if (type === "inlineStr") value = stringItemText(cell.is);
        else if (type === "b") value = textOf(cell.v) === "1" ? "TRUE" : "FALSE";
        else if (type === "e") value = "";
        else value = textOf(cell.v);
        while (cells.length < col) cells.push("");
        cells[col] = value;
      }
      const declared = Number(textOf(row["@_r"]));
      rows.push(cells);
      rowNumbers.push(Number.isFinite(declared) && declared > 0 ? declared : i + 1);
    });
    return { sheetName: chosen.name, sheetNames, rows, rowNumbers };
  } finally {
    zip.close();
  }
}
