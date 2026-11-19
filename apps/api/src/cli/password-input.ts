import { createInterface } from "node:readline";
import { readFileSync, statSync } from "node:fs";
import { Writable, type Readable } from "node:stream";

/**
 * Password intake for the owner bootstrap CLI. There is deliberately NO
 * command-line argument and NO environment variable for the password:
 * argv ends up in shell history and `ps`, env vars in `docker inspect`
 * and process listings. The three supported sources are:
 *
 *   1. interactive hidden prompt (typed twice, never echoed)
 *   2. standard input        (--password-stdin: `printf %s "$PW" | ...`)
 *   3. a file                (--password-file: e.g. a 0600 file you delete afterwards)
 */

/** Strips exactly one trailing newline (LF or CRLF); everything else is part of the password. */
export function stripOneTrailingNewline(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

/**
 * Normalizes a password that arrived through a pipe or a file: removes ONE
 * leading UTF-8 byte-order mark and ONE trailing newline, nothing else.
 *
 * The BOM matters in practice: Windows PowerShell 5.1 prepends U+FEFF when it
 * pipes text to a native program, and Notepad writes it at the start of a
 * "UTF-8" file. Left in place it would silently become the first character of
 * the stored password, and the owner could never sign in by typing it — this
 * was caught by the real-stack bootstrap drill, not assumed.
 */
export function normalizePasswordInput(raw: string): string {
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return stripOneTrailingNewline(withoutBom);
}

export async function readPasswordFromStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return normalizePasswordInput(Buffer.concat(chunks).toString("utf8"));
}

export interface PasswordFileResult {
  password: string;
  /** Present when the file is readable by group/other (POSIX only) — the CLI warns, it does not refuse. */
  permissionWarning?: string;
}

export function readPasswordFromFile(path: string): PasswordFileResult {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("The password path is not a regular file.");
  const password = normalizePasswordInput(readFileSync(path, "utf8"));
  const looseMode = process.platform !== "win32" && (stat.mode & 0o077) !== 0;
  return looseMode
    ? {
        password,
        permissionWarning: `The password file is readable by other users (mode ${(stat.mode & 0o777).toString(8)}). Delete it as soon as the command finishes.`,
      }
    : { password };
}

/**
 * Prompts for one line without echoing it. The prompt text is written to
 * `output`; the typed characters are swallowed by a muted writable that
 * readline believes is the terminal.
 */
export function promptHidden(question: string, input: Readable, output: NodeJS.WritableStream): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let muted = false;
    const sink = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) output.write(chunk, encoding as BufferEncoding);
        callback();
      },
    });
    const rl = createInterface({ input, output: sink, terminal: true });
    let answered = false;
    output.write(question);
    muted = true;
    rl.once("line", (line) => {
      answered = true;
      muted = false;
      output.write("\n");
      rl.close();
      resolve(line);
    });
    rl.once("close", () => {
      if (!answered) {
        muted = false;
        output.write("\n");
        reject(new Error("Input closed before a password was entered."));
      }
    });
  });
}

/** Prompts twice and requires both entries to match. */
export async function promptPasswordTwice(input: Readable, output: NodeJS.WritableStream): Promise<string> {
  const first = await promptHidden("Owner password (input hidden): ", input, output);
  const second = await promptHidden("Repeat password: ", input, output);
  if (first !== second) throw new Error("The two password entries do not match.");
  return first;
}
