import { execFile, spawn } from "node:child_process";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RenderCommand } from "./command.js";

const execFileAsync = promisify(execFile);

export class RenderCancelledError extends Error {
  constructor() {
    super("The render was cancelled.");
    this.name = "RenderCancelledError";
  }
}

export class RenderTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`FFmpeg took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`);
    this.name = "RenderTimeoutError";
  }
}

export class RenderFailedError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = "RenderFailedError";
  }
}

const versionCache = new Map<string, "-filter_complex_script" | "-/filter_complex">();

/**
 * FFmpeg 7 replaced `-filter_complex_script <file>` by `-/filter_complex <file>` (and later versions refuse the old
 * option); FFmpeg 5 and 6 only know the old one. The version string decides: "5.1.9-0+deb12u1", "6.1.1-3ubuntu5",
 * "9.0.1-full_build". A build with no version number (a git snapshot) is recent, so it gets the new form.
 */
export async function filterScriptFlag(ffmpegPath: string): Promise<"-filter_complex_script" | "-/filter_complex"> {
  const cached = versionCache.get(ffmpegPath);
  if (cached) return cached;
  const { stdout } = await execFileAsync(ffmpegPath, ["-version"], { timeout: 15_000 });
  const major = Number(/ffmpeg version n?(\d+)\./i.exec(stdout)?.[1]);
  const flag = Number.isFinite(major) && major < 7 ? "-filter_complex_script" : "-/filter_complex";
  versionCache.set(ffmpegPath, flag);
  return flag;
}

export interface RunRenderOptions {
  ffmpegPath: string;
  /** The job's own directory: the font, the text files and the filter graph are written here and FFmpeg runs here. */
  workDir: string;
  command: RenderCommand;
  /** The font file to copy into the work directory as `font.ttf` (the command refers to it by that name). */
  fontSourcePath: string;
  fontFileName?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with how much of the output FFmpeg has produced, in milliseconds (real, measured by FFmpeg itself). */
  onProgress?: (producedMs: number) => void;
}

export interface RunRenderResult {
  stderrTail: string;
  elapsedMs: number;
}

/** Runs the command. Cancellation kills FFmpeg at once; a timeout does the same; a failure carries FFmpeg's own last words. */
export async function runRender(options: RunRenderOptions): Promise<RunRenderResult> {
  const { command, workDir } = options;
  await copyFile(options.fontSourcePath, join(workDir, options.fontFileName ?? "font.ttf"));
  for (const f of command.files) await writeFile(join(workDir, f.name), f.content, "utf8");
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;

  return new Promise<RunRenderResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new RenderCancelledError());
      return;
    }
    const child = spawn(options.ffmpegPath, command.args, { cwd: workDir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    let buffered = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(() => reject(new RenderCancelledError()));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new RenderTimeoutError(timeoutMs)));
    }, timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        // out_time_us is microseconds; some builds print the same number as out_time_ms
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && options.onProgress) options.onProgress(Math.round(Number(m[1]) / 1000));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(() => reject(new RenderFailedError(err.code === "ENOENT" ? `FFmpeg "${options.ffmpegPath}" was not found.` : `FFmpeg could not be started: ${err.message}`, null, "")));
    });
    child.on("close", (code, signal) => {
      finish(() => {
        if (code === 0) resolve({ stderrTail: stderr, elapsedMs: Date.now() - started });
        else reject(new RenderFailedError(`FFmpeg stopped with ${code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`}.`, code, stderr));
      });
    });
  });
}
