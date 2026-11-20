import { createWriteStream } from "node:fs";
import { deflateRawSync } from "node:zlib";

/**
 * Test-only: writes ZIP bytes by hand, because real archivers refuse to produce the hostile archives these tests need
 * (traversal names, lying sizes, symlinks, encrypted flags). Not exported from the package.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32Update(crc: number, data: Buffer): number {
  let c = crc ^ 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export const crc32 = (data: Buffer) => crc32Update(0, data);

export interface TestEntry {
  name: string;
  data?: Buffer;
  /** 0 = stored, 8 = deflate (default 0). */
  method?: 0 | 8;
  /** Overrides the declared uncompressed size (a lying header). */
  declaredSize?: number;
  /** Unix mode bits in the high 16 bits of the external attributes, e.g. 0o120777 for a symlink. */
  unixMode?: number;
  /** General-purpose flag bits; bit 0 marks the entry as encrypted. */
  flags?: number;
}

export function buildZip(entries: TestEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 0;
    const encrypted = ((e.flags ?? 0) & 1) === 1;
    let body = method === 8 ? deflateRawSync(raw) : raw;
    if (encrypted && method === 0) body = Buffer.concat([Buffer.alloc(12), raw]); // ZipCrypto header, as real encrypted archives have
    const crc = crc32(raw);
    const flags = (e.flags ?? 0) | 0x0800; // UTF-8 names
    const uncompressed = e.declaredSize ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.unixMode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

/** Streams a one-entry archive of `size` zero bytes (stored) to disk without ever holding it in memory. */
export async function writeLargeStoredZip(path: string, entryName: string, size: number): Promise<void> {
  const name = Buffer.from(entryName, "utf8");
  const chunk = Buffer.alloc(1024 * 1024);
  let crc = 0;
  for (let remaining = size; remaining > 0; remaining -= chunk.length) crc = crc32Update(crc, remaining >= chunk.length ? chunk : chunk.subarray(0, remaining));

  const out = createWriteStream(path);
  const write = (b: Buffer) => new Promise<void>((resolve, reject) => out.write(b, (err) => (err ? reject(err) : resolve())));

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(size, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(name.length, 26);
  await write(local);
  await write(name);
  for (let remaining = size; remaining > 0; remaining -= chunk.length) await write(remaining >= chunk.length ? chunk : chunk.subarray(0, remaining));

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(size, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  const centralOffset = 30 + name.length + size;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  await write(central);
  await write(name);
  await write(end);
  await new Promise<void>((resolve) => out.end(resolve));
}
