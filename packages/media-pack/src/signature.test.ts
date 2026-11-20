import { describe, expect, it } from "vitest";
import { detectSignature, looksLikeText, validateUpload } from "./signature.js";
import { fileTypeFor } from "./file-types.js";

const pad = (b: number[], to = 64) => Buffer.concat([Buffer.from(b), Buffer.alloc(Math.max(0, to - b.length))]);
const riff = (form: string) => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from(form), Buffer.alloc(40)]);
const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftyp"), Buffer.from(brand), Buffer.alloc(40)]);

const HEADS = {
  jpeg: pad([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]),
  png: pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  webp: riff("WEBP"),
  wav: riff("WAVE"),
  mp4: ftyp("isom"),
  mov: ftyp("qt  "),
  mp3: Buffer.concat([Buffer.from("ID3"), Buffer.from([3, 0, 0, 0, 0, 0, 0x21]), Buffer.alloc(40)]),
  mp3frame: pad([0xff, 0xfb, 0x90, 0x00]),
  zip: pad([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]),
  text: Buffer.from("line one\nline two, with a comma\n"),
};

describe("signature detection", () => {
  it.each([
    ["jpeg", HEADS.jpeg],
    ["png", HEADS.png],
    ["webp", HEADS.webp],
    ["wav", HEADS.wav],
    ["mp4", HEADS.mp4],
    ["mov", HEADS.mov],
    ["mp3", HEADS.mp3],
    ["mp3", HEADS.mp3frame],
    ["zip", HEADS.zip],
    ["text", HEADS.text],
  ])("recognises %s", (kind, head) => {
    expect(detectSignature(head)).toBe(kind);
  });

  it("recognises nothing in random binary", () => {
    expect(detectSignature(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull(); // ELF
    expect(detectSignature(Buffer.from("MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00", "latin1"))).toBeNull(); // PE
  });

  it("treats a UTF-8 text with a multi-byte character cut at the window edge as text", () => {
    const text = Buffer.from("é".repeat(2048), "utf8"); // 4096 bytes, may be cut mid-character
    expect(looksLikeText(text.subarray(0, 4095))).toBe(true);
  });
});

describe("validateUpload (extension, declared MIME and signature must agree)", () => {
  const ok = (name: string, mime: string | null, head: Buffer) => validateUpload(name, mime, head);

  it("accepts every supported type with the right bytes", () => {
    expect(ok("a.mp4", "video/mp4", HEADS.mp4).ok).toBe(true);
    expect(ok("a.mov", "video/quicktime", HEADS.mov).ok).toBe(true);
    expect(ok("a.JPG", "image/jpeg", HEADS.jpeg).ok).toBe(true);
    expect(ok("a.jpeg", "image/jpeg", HEADS.jpeg).ok).toBe(true);
    expect(ok("a.png", "image/png", HEADS.png).ok).toBe(true);
    expect(ok("a.webp", "image/webp", HEADS.webp).ok).toBe(true);
    expect(ok("a.mp3", "audio/mpeg", HEADS.mp3).ok).toBe(true);
    expect(ok("a.mp3", "audio/mpeg", HEADS.mp3frame).ok).toBe(true);
    expect(ok("a.wav", "audio/x-wav", HEADS.wav).ok).toBe(true);
    expect(ok("a.txt", "text/plain", HEADS.text).ok).toBe(true);
    expect(ok("a.csv", "application/vnd.ms-excel", HEADS.text).ok).toBe(true); // what Windows browsers send for CSV
    expect(ok("a.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", HEADS.zip).ok).toBe(true);
    expect(ok("a.zip", "application/x-zip-compressed", HEADS.zip).ok).toBe(true);
  });

  it("accepts a generic or missing declared MIME type (the signature decides)", () => {
    expect(ok("a.png", "application/octet-stream", HEADS.png).ok).toBe(true);
    expect(ok("a.png", "", HEADS.png).ok).toBe(true);
    expect(ok("a.png", null, HEADS.png).ok).toBe(true);
    expect(ok("a.txt", "text/plain; charset=utf-8", HEADS.text).ok).toBe(true);
  });

  it("accepts an MP4/MOV container under either extension", () => {
    expect(ok("a.mov", "video/quicktime", HEADS.mp4).ok).toBe(true);
    expect(ok("a.mp4", "video/mp4", HEADS.mov).ok).toBe(true);
  });

  it("rejects a file whose bytes are not what its extension claims", () => {
    const r = ok("holiday.png", "image/png", HEADS.zip);
    expect(r).toMatchObject({ ok: false, code: "SIGNATURE_MISMATCH" });
    expect((r as { message: string }).message).toMatch(/zip/);
    expect(ok("clip.mp4", "video/mp4", HEADS.png)).toMatchObject({ ok: false, code: "SIGNATURE_MISMATCH" });
    expect(ok("song.mp3", "audio/mpeg", HEADS.wav)).toMatchObject({ ok: false, code: "SIGNATURE_MISMATCH" });
    expect(ok("notes.txt", "text/plain", HEADS.png)).toMatchObject({ ok: false, code: "SIGNATURE_MISMATCH" });
    expect(ok("data.xlsx", undefined, HEADS.text)).toMatchObject({ ok: false, code: "SIGNATURE_MISMATCH" });
  });

  it("rejects an executable renamed to a media extension", () => {
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(ok("video.mp4", "video/mp4", elf)).toMatchObject({ ok: false, code: "SIGNATURE_MISMATCH" });
    expect(ok("notes.txt", "text/plain", elf)).toMatchObject({ ok: false, code: "SIGNATURE_MISMATCH" });
  });

  it("rejects a declared MIME type that contradicts the extension", () => {
    expect(ok("a.png", "text/html", HEADS.png)).toMatchObject({ ok: false, code: "MIME_MISMATCH" });
    expect(ok("a.mp4", "image/png", HEADS.mp4)).toMatchObject({ ok: false, code: "MIME_MISMATCH" });
  });

  it("rejects extensions that are not on the allow-list, whatever the content", () => {
    for (const name of ["a.exe", "a.svg", "a.html", "a.php", "a.js", "a.pdf", "a.gif", "a.avi", "archive.7z", "noextension"]) {
      expect(ok(name, "application/octet-stream", HEADS.text), name).toMatchObject({ ok: false, code: "UNSUPPORTED_TYPE" });
    }
    expect(fileTypeFor("a.exe")).toBeNull();
  });

  it("rejects an empty file and UTF-16 text", () => {
    expect(ok("a.txt", "text/plain", Buffer.alloc(0))).toMatchObject({ ok: false, code: "EMPTY_FILE" });
    expect(ok("a.txt", "text/plain", Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toMatchObject({ ok: false, code: "UTF16_TEXT" });
  });

  it("a note that merely starts with 'ID3' is still a text file", () => {
    expect(ok("notes.txt", "text/plain", Buffer.from("ID3 tags explained\nmore text\n")).ok).toBe(true);
  });
});
