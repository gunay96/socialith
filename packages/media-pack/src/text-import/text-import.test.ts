import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { buildXlsx } from "../testing/xlsx-builder.js";
import { buildZip } from "../testing/zip-builder.js";
import { TextImportError, decodeTextBytes, detectDelimiter, formatForFileName, interpretTable, matchHeader, parseCsv, parseTextImport, parseTxt, readXlsx } from "./index.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "text-import-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, data: string | Buffer) => {
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
};
const opts = { maxRows: 100, maxBytes: 5_000_000 };
const failsWith = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TextImportError);
  expect((err as TextImportError).code).toBe(code);
};

describe("decodeTextBytes", () => {
  it("reads UTF-8, dropping a BOM", () => {
    expect(decodeTextBytes(Buffer.from("\uFEFFgüzel ışık", "utf8"))).toEqual({ text: "güzel ışık", encoding: "utf-8" });
  });
  it("falls back to Windows-1254 (Turkish ANSI) for files Excel saved that way", () => {
    // "şğı İ" in windows-1254: ş=0xFE ğ=0xF0 ı=0xFD İ=0xDD
    const r = decodeTextBytes(Buffer.from([0xfe, 0xf0, 0xfd, 0x20, 0xdd]));
    expect(r).toEqual({ text: "şğı İ", encoding: "windows-1254" });
  });
  it("refuses empty and binary data", () => {
    expect(() => decodeTextBytes(Buffer.alloc(0))).toThrow(TextImportError);
    expect(() => decodeTextBytes(Buffer.from([0x41, 0x00, 0x42]))).toThrow(TextImportError);
  });
});

describe("TXT", () => {
  it("one text per line", () => {
    const r = parseTxt("Never give up\n\nStay hungry\n  \nKeep going\n", { maxRows: 10 });
    expect(r.split).toBe("LINE");
    expect(r.texts).toEqual(["Never give up", "Stay hungry", "Keep going"]);
    expect(r.startLines).toEqual([1, 3, 5]);
  });
  it("blank-line separated multi-line texts are detected automatically", () => {
    const r = parseTxt("Line one\nline two\n\nSecond text\nsecond line\r\n", { maxRows: 10 });
    expect(r.split).toBe("BLANK_LINE");
    expect(r.texts).toEqual(["Line one\nline two", "Second text\nsecond line"]);
  });
  it("can be forced either way", () => {
    expect(parseTxt("a\nb\n\nc", { maxRows: 10, split: "LINE" }).texts).toEqual(["a", "b", "c"]);
  });
  it("refuses a file with no text and one with too many texts", () => {
    expect(() => parseTxt("\n \n", { maxRows: 10 })).toThrow(TextImportError);
    expect(() => parseTxt("a\nb\nc", { maxRows: 2 })).toThrow(TextImportError);
  });
});

describe("CSV", () => {
  it("parses quotes, doubled quotes, embedded delimiters and line breaks", () => {
    const { rows } = parseCsv('text,category\n"Hello, world",Motivation\n"She said ""go""",Humor\n"two\nlines",Lifestyle\n', { maxRows: 10 });
    expect(rows).toEqual([["text", "category"], ["Hello, world", "Motivation"], ['She said "go"', "Humor"], ["two\nlines", "Lifestyle"]]);
  });
  it("handles CRLF, a missing final newline and empty fields", () => {
    expect(parseCsv("a,b\r\n,x\r\ny,", { maxRows: 10 }).rows).toEqual([["a", "b"], ["", "x"], ["y", ""]]);
  });
  it("detects the semicolon Excel writes in Turkish and German locales", () => {
    expect(detectDelimiter("metin;kategori\nmerhaba;Motivasyon")).toBe(";");
    expect(detectDelimiter('"a;b",c\n1,2')).toBe(",");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
  });
  it("stops, instead of truncating, when there are too many rows", () => {
    expect(() => parseCsv("a\n1\n2\n3\n4", { maxRows: 2 })).toThrow(/more than 2 rows/);
  });
});

describe("column detection", () => {
  it("recognises English and Turkish header names", () => {
    expect(matchHeader("Text")).toBe("text");
    expect(matchHeader("  METİN ")).toBe("text");
    expect(matchHeader("Kategori")).toBe("category");
    expect(matchHeader("Dil")).toBe("language");
    expect(matchHeader("Kaynak")).toBe("source");
    expect(matchHeader("Yazar")).toBe("author");
    expect(matchHeader("price")).toBeNull();
  });
  it("maps columns by header, in any order, and numbers rows as in the file", () => {
    const t = interpretTable([["Category", "Text", "Lang", "Source"], ["Motivation", "Keep going", "en", "my notes"], ["", "", "", ""], ["Football", "What a goal", "", ""]]);
    expect(t.columns).toMatchObject({ text: 1, category: 0, language: 2, source: 3 });
    expect(t.rows).toEqual([
      { rowNumber: 2, text: "Keep going", category: "Motivation", language: "en", source: "my notes", author: null, notes: null },
      { rowNumber: 4, text: "What a goal", category: "Football", language: null, source: null, author: null, notes: null },
    ]);
    expect(t.emptyRows).toBe(1);
  });
  it("a single column without a header is all texts; with a recognised header the header is skipped", () => {
    expect(interpretTable([["one"], ["two"]]).rows.map((r) => r.text)).toEqual(["one", "two"]);
    expect(interpretTable([["text"], ["one"], ["two"]]).rows.map((r) => r.text)).toEqual(["one", "two"]);
  });
  it("refuses several unnamed columns, but accepts an explicit text column", () => {
    expect(() => interpretTable([["foo", "bar"], ["a", "b"]])).toThrow(/Could not tell which column/);
    expect(interpretTable([["foo", "bar"], ["a", "b"]], { textColumn: "bar" }).rows[0]?.text).toBe("b");
    expect(interpretTable([["a", "b"], ["c", "d"]], { hasHeader: false, textColumn: 1 }).rows.map((r) => r.text)).toEqual(["b", "d"]);
  });
  it("refuses a header with nothing under it", () => {
    expect(() => interpretTable([["text", "category"]])).toThrow(TextImportError);
  });
});

describe("XLSX", () => {
  it("reads shared strings, numbers and several sheets; the first sheet by default", async () => {
    const p = file("a.xlsx", buildXlsx([{ name: "Quotes", rows: [["Text", "Category", "Rating"], ["Keep going", "Motivation", 5], ["Güzel gün", "Lifestyle", 4]] }, { name: "Other", rows: [["x"]] }]));
    const t = await readXlsx(p, { maxRows: 100 });
    expect(t.sheetName).toBe("Quotes");
    expect(t.sheetNames).toEqual(["Quotes", "Other"]);
    expect(t.rows).toEqual([["Text", "Category", "Rating"], ["Keep going", "Motivation", "5"], ["Güzel gün", "Lifestyle", "4"]]);
  });
  it("reads inline strings, booleans, sparse cells and explicit row numbers", async () => {
    const p = file("b.xlsx", buildXlsx([{ name: "S", rows: [["Text"], ["a"], [null, "far"]] }], { sharedStrings: false, rowNumbers: [1, 2, 7] }));
    const t = await readXlsx(p, { maxRows: 100 });
    expect(t.rows).toEqual([["Text"], ["a"], ["", "far"]]);
    expect(t.rowNumbers).toEqual([1, 2, 7]);
  });
  it("chooses a sheet by name and says when it does not exist", async () => {
    const p = file("c.xlsx", buildXlsx([{ name: "A", rows: [["one"]] }, { name: "B", rows: [["two"]] }]));
    expect((await readXlsx(p, { maxRows: 10, sheet: "b" })).rows).toEqual([["two"]]);
    await failsWith(readXlsx(p, { maxRows: 10, sheet: "Z" }), "XLSX_NO_SHEET");
  });
  it("end to end: header detection and row numbers through parseTextImport", async () => {
    const p = file("d.xlsx", buildXlsx([{ name: "S", rows: [["Metin", "Kategori"], ["Vazgeçme", "Motivasyon"], ["Devam et", "Motivasyon"]] }]));
    const r = await parseTextImport(p, "d.xlsx", opts);
    expect(r.format).toBe("XLSX");
    expect(r.rows.map((x) => [x.rowNumber, x.text, x.category])).toEqual([[2, "Vazgeçme", "Motivasyon"], [3, "Devam et", "Motivasyon"]]);
  });
  it("refuses a file that is not a workbook", async () => {
    await failsWith(readXlsx(file("e.xlsx", "not a zip at all"), { maxRows: 10 }), "XLSX_INVALID");
    await failsWith(readXlsx(file("f.xlsx", buildZip([{ name: "hello.txt", data: Buffer.from("hi") }])), { maxRows: 10 }), "XLSX_INVALID");
  });
  it("refuses an encrypted workbook", async () => {
    const p = file("g.xlsx", buildZip([{ name: "xl/workbook.xml", data: Buffer.from("secret"), flags: 1 }]));
    await failsWith(readXlsx(p, { maxRows: 10 }), "XLSX_UNSAFE");
  });
  it("refuses a workbook part with an XML entity declaration (entity bomb)", async () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><sst xmlns="x"><si><t>&lol2;</t></si></sst>';
    const p = file("h.xlsx", buildXlsx([{ name: "S", rows: [["text"], ["a"]] }], { override: { "xl/sharedStrings.xml": bomb } }));
    await failsWith(readXlsx(p, { maxRows: 10 }), "XLSX_UNSAFE");
  });
  it("refuses a zip-bomb part by the bytes that actually inflate, whatever the header claims", async () => {
    const huge = Buffer.alloc(40 * 1024 * 1024, 0x20);
    const sheet = `<worksheet><sheetData></sheetData></worksheet>${huge.toString("latin1")}`;
    const p = file("i.xlsx", buildXlsx([{ name: "S", rows: [["text"]] }], { override: { "xl/worksheets/sheet1.xml": sheet } }));
    await failsWith(readXlsx(p, { maxRows: 10 }), "XLSX_UNSAFE");
  });
  it("refuses a sheet with more rows than the limit", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => [`t${i}`]);
    await failsWith(readXlsx(file("j.xlsx", buildXlsx([{ name: "S", rows }])), { maxRows: 5 }), "TOO_MANY_ROWS");
  });
  it("refuses a workbook with an unsafe part path", async () => {
    const p = file("k.xlsx", buildZip([{ name: "../evil.xml", data: Buffer.from("x"), method: 8 }]));
    const err = await readXlsx(p, { maxRows: 10 }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TextImportError);
  });
  it("does not evaluate formulas: it reads the stored result as text", async () => {
    const sheet = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>text</t></is></c></row><row r="2"><c r="A2" t="str"><f>HYPERLINK("http://evil","x")</f><v>cached result</v></c></row></sheetData></worksheet>';
    const p = file("l.xlsx", buildXlsx([{ name: "S", rows: [["text"]] }], { override: { "xl/worksheets/sheet1.xml": sheet } }));
    expect((await readXlsx(p, { maxRows: 10 })).rows).toEqual([["text"], ["cached result"]]);
  });
  it("is cheap about unused junk: a deflated entry we never read is not inflated", async () => {
    const junk = deflateRawSync(Buffer.alloc(50 * 1024 * 1024, 0x61));
    expect(junk.length).toBeLessThan(200_000);
    const p = file("m.xlsx", buildXlsx([{ name: "S", rows: [["text"], ["ok"]] }], { extraEntries: [{ name: "docProps/thumbnail.bin", data: Buffer.alloc(10), method: 0 }] }));
    expect((await readXlsx(p, { maxRows: 10 })).rows).toEqual([["text"], ["ok"]]);
  });
});

describe("parseTextImport", () => {
  it("imports a CSV with a header", async () => {
    const r = await parseTextImport(file("1.csv", "text;category;language\nMerhaba dünya;Motivation;tr\nHello;Motivation;en\n"), "1.csv", opts);
    expect(r).toMatchObject({ format: "CSV", delimiter: ";", encoding: "utf-8" });
    expect(r.rows.map((x) => [x.text, x.language])).toEqual([["Merhaba dünya", "tr"], ["Hello", "en"]]);
  });
  it("imports a TXT", async () => {
    const r = await parseTextImport(file("1.txt", "one\ntwo\n"), "1.txt", opts);
    expect(r).toMatchObject({ format: "TXT", split: "LINE" });
    expect(r.rows.map((x) => x.text)).toEqual(["one", "two"]);
  });
  it("refuses empty files, unknown types and files above the byte limit", async () => {
    await failsWith(parseTextImport(file("2.txt", ""), "2.txt", opts), "EMPTY_FILE");
    await failsWith(parseTextImport(file("3.pdf", "x"), "3.pdf", opts), "NOT_TEXT");
    await failsWith(parseTextImport(file("4.csv", "text\n" + "x".repeat(100)), "4.csv", { ...opts, maxBytes: 50 }), "TOO_MANY_ROWS");
    await failsWith(parseTextImport(file("5.csv", Buffer.from([0x74, 0x00, 0x01])), "5.csv", opts), "NOT_TEXT");
  });
  it("knows the three formats", () => {
    expect(formatForFileName("A.XLSX")).toBe("XLSX");
    expect(formatForFileName("a.csv")).toBe("CSV");
    expect(formatForFileName("a.txt")).toBe("TXT");
    expect(formatForFileName("a.docx")).toBeNull();
  });
});
