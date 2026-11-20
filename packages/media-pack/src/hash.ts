import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** SHA-256 of a file computed from a read stream: the file is never held in memory. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Reads only the first `bytes` of a file (for signature checks). */
export async function readHead(path: string, bytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let read = 0;
  const stream = createReadStream(path, { start: 0, end: bytes - 1 });
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
    read += (chunk as Buffer).length;
    if (read >= bytes) break;
  }
  return Buffer.concat(chunks).subarray(0, bytes);
}
