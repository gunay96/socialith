import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizePasswordInput,
  promptHidden,
  promptPasswordTwice,
  readPasswordFromFile,
  readPasswordFromStream,
  stripOneTrailingNewline,
} from "./password-input.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile(content: string, mode = 0o600): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pw-test-"));
  tempDirs.push(dir);
  const file = path.join(dir, "pw");
  writeFileSync(file, content);
  chmodSync(file, mode);
  return file;
}

describe("stripOneTrailingNewline", () => {
  it("strips exactly one LF or CRLF and nothing else", () => {
    expect(stripOneTrailingNewline("abc\n")).toBe("abc");
    expect(stripOneTrailingNewline("abc\r\n")).toBe("abc");
    expect(stripOneTrailingNewline("abc\n\n")).toBe("abc\n");
    expect(stripOneTrailingNewline(" abc ")).toBe(" abc ");
  });
});

describe("normalizePasswordInput", () => {
  it("removes one leading BOM and one trailing newline only", () => {
    expect(normalizePasswordInput("\uFEFFsecret-pass\r\n")).toBe("secret-pass");
    expect(normalizePasswordInput("\uFEFF\uFEFFx\n")).toBe("\uFEFFx");
    expect(normalizePasswordInput("sec\uFEFFret")).toBe("sec\uFEFFret");
  });
});

describe("readPasswordFromStream", () => {
  it("strips a BOM that PowerShell 5.1 prepends to piped text", async () => {
    expect(await readPasswordFromStream(Readable.from(["\uFEFFTr0ub4dor&3-correct-horse\r\n"]))).toBe("Tr0ub4dor&3-correct-horse");
  });

  it("reads the whole stream and keeps internal/leading/trailing spaces", async () => {
    expect(await readPasswordFromStream(Readable.from(["  pass ", "phrase \n"]))).toBe("  pass phrase ");
  });
});

describe("readPasswordFromFile", () => {
  it("strips a BOM written by Windows editors", () => {
    expect(readPasswordFromFile(tempFile("\uFEFFs3cret-passphrase\r\n")).password).toBe("s3cret-passphrase");
  });

  it("reads and trims one trailing newline", () => {
    expect(readPasswordFromFile(tempFile("s3cret-passphrase\n")).password).toBe("s3cret-passphrase");
  });

  it.skipIf(process.platform === "win32")("warns (does not refuse) when the file is group/world readable", () => {
    const loose = readPasswordFromFile(tempFile("x", 0o644));
    expect(loose.permissionWarning).toMatch(/readable by other users/);
    expect(readPasswordFromFile(tempFile("x", 0o600)).permissionWarning).toBeUndefined();
  });

  it("refuses a directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pw-dir-"));
    tempDirs.push(dir);
    expect(() => readPasswordFromFile(dir)).toThrow(/regular file/);
  });
});

describe("promptHidden", () => {
  it("returns the typed line, shows the prompt, and never echoes the input", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (c: Buffer) => written.push(c.toString()));

    const pending = promptHidden("Password: ", input, output);
    input.write("hunter2-super-secret\n");
    expect(await pending).toBe("hunter2-super-secret");

    const shown = written.join("");
    expect(shown).toContain("Password: ");
    expect(shown).not.toContain("hunter2");
  });

  it("rejects when input closes before a line arrives", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = promptHidden("Password: ", input, output);
    input.end();
    await expect(pending).rejects.toThrow(/closed/);
  });
});

describe("promptPasswordTwice", () => {
  it("accepts matching entries and never echoes either", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (c: Buffer) => written.push(c.toString()));

    const pending = promptPasswordTwice(input, output);
    input.write("matching-pass-phrase-1\n");
    await new Promise((r) => setTimeout(r, 20));
    input.write("matching-pass-phrase-1\n");

    expect(await pending).toBe("matching-pass-phrase-1");
    expect(written.join("")).not.toContain("matching-pass-phrase");
  });

  it("rejects mismatching entries", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = promptPasswordTwice(input, output);
    input.write("first-entry-aaaaaa\n");
    await new Promise((r) => setTimeout(r, 20));
    input.write("second-entry-bbbbb\n");
    await expect(pending).rejects.toThrow(/do not match/);
  });
});
