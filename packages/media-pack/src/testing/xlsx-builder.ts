import { buildZip, type TestEntry } from "./zip-builder.js";

/**
 * Test-only: writes a minimal but structurally real .xlsx (the parts Excel itself writes), so the importer is tested
 * against the real file layout without any spreadsheet library.
 */
export type Cell = string | number | boolean | null;
export interface SheetInput {
  name: string;
  rows: Cell[][];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const colName = (i: number) => {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

export interface XlsxBuildOptions {
  /** Store strings in sharedStrings.xml (what Excel does). Default true; false writes inline strings. */
  sharedStrings?: boolean;
  /** Extra or replacement parts, e.g. a hostile one. */
  extraEntries?: TestEntry[];
  /** Replace the contents of a part by name. */
  override?: Record<string, string>;
  /** Rows to skip numbering for: write each row at its own explicit r="" number. */
  rowNumbers?: number[];
}

export function buildXlsx(sheets: SheetInput[], options: XlsxBuildOptions = {}): Buffer {
  const useShared = options.sharedStrings ?? true;
  const shared: string[] = [];
  const sharedIndex = (s: string): number => {
    const found = shared.indexOf(s);
    if (found >= 0) return found;
    shared.push(s);
    return shared.length - 1;
  };

  const sheetParts = sheets.map((sheet, si) => {
    const rows = sheet.rows
      .map((row, ri) => {
        const rowNo = (si === 0 ? options.rowNumbers?.[ri] : undefined) ?? ri + 1;
        const cells = row
          .map((cell, ci) => {
            if (cell === null || cell === "") return "";
            const ref = `${colName(ci)}${rowNo}`;
            if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
            if (typeof cell === "boolean") return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
            return useShared ? `<c r="${ref}" t="s"><v>${sharedIndex(cell)}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(cell)}</t></is></c>`;
          })
          .join("");
        return `<row r="${rowNo}">${cells}</row>`;
      })
      .join("");
    return { name: `xl/worksheets/sheet${si + 1}.xml`, xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>` };
  });

  const parts: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
  };
  for (const p of sheetParts) parts[p.name] = p.xml;
  if (useShared) {
    parts["xl/sharedStrings.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")}</sst>`;
  }
  Object.assign(parts, options.override ?? {});
  const entries: TestEntry[] = Object.entries(parts).map(([name, xml]) => ({ name, data: Buffer.from(xml, "utf8"), method: 8 }));
  return buildZip([...entries, ...(options.extraEntries ?? [])]);
}
