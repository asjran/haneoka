import { BOX_LIMITS, BoxImportError } from "@haneoka/game-data-exporter";
import { Inflate, Gunzip } from "fflate";
import { parseBoxFiles } from "@haneoka/game-data-exporter";
/** Read only save-sized entries; a large iMazing export need not fit in memory. */
export async function readSaveArchive(file: Blob, progress: (completed: number, total: number) => void) {
  const invalid = () => new BoxImportError("box_invalid_zip");
  const tailAt = Math.max(0, file.size - 65557),
    tail = new Uint8Array(await file.slice(tailAt).arrayBuffer());
  const tv = new DataView(tail.buffer);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--)
    if (tv.getUint32(i, true) === 0x06054b50 && i + 22 + tv.getUint16(i + 20, true) === tail.length) {
      end = i;
      break;
    }
  if (end < 0 || tv.getUint16(end + 4, true) || tv.getUint16(end + 6, true)) throw invalid();
  const count = tv.getUint16(end + 10, true),
    size = tv.getUint32(end + 12, true),
    offset = tv.getUint32(end + 16, true);
  if (
    count === 65535 ||
    offset === 0xffffffff ||
    size > 32 * 1024 * 1024 ||
    offset + size !== tailAt + end ||
    count !== tv.getUint16(end + 8, true)
  )
    throw new BoxImportError("box_unsupported_zip");
  const central = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer()),
    view = new DataView(central.buffer);
  const files: Blob[] = [],
    names = new Set<string>();
  let at = 0,
    total = 0,
    scannedBytes = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > central.length || view.getUint32(at, true) !== 0x02014b50) throw invalid();
    const flags = view.getUint16(at + 8, true),
      method = view.getUint16(at + 10, true),
      crc = view.getUint32(at + 16, true),
      compressed = view.getUint32(at + 20, true),
      expanded = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true),
      extra = view.getUint16(at + 30, true),
      comment = view.getUint16(at + 32, true),
      local = view.getUint32(at + 42, true);
    if (at + 46 + nameLength + extra + comment > central.length) throw invalid();
    const path = new TextDecoder("utf-8", { fatal: true })
      .decode(central.subarray(at + 46, at + 46 + nameLength))
      .replaceAll("\\", "/");
    const attributes = view.getUint32(at + 38, true);
    at += 46 + nameLength + extra + comment;
    if (
      path.startsWith("/") ||
      path.includes(":") ||
      /[\u0000-\u001f]/.test(path) ||
      path.split("/").some((p) => p === "." || p === "..") ||
      names.has(path)
    )
      throw new BoxImportError("box_invalid_zip_path");
    names.add(path);
    if (
      path.endsWith("/") ||
      expanded > BOX_LIMITS.fileBytes ||
      /\.(png|jpg|jpeg|webp|mp4|mp3|ogg|bundle|plist|db)$/i.test(path) ||
      path
        .split("/")
        .some((p) => ["Library", "tmp", "EncryptedBundles", "Addressables", "UnityCache", "il2cpp"].includes(p))
    )
      continue;
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      ((attributes >>> 16) & 0xf000) === 0xa000 ||
      compressed > BOX_LIMITS.fileBytes
    )
      throw new BoxImportError("box_unsupported_zip");
    if (local + 30 > offset) throw invalid();
    const header = new Uint8Array(await file.slice(local, local + 30).arrayBuffer()),
      hv = new DataView(header.buffer);
    if (hv.getUint32(0, true) !== 0x04034b50 || hv.getUint16(8, true) !== method || hv.getUint16(6, true) !== flags)
      throw invalid();
    const localNameSize = hv.getUint16(26, true),
      start = local + 30 + localNameSize + hv.getUint16(28, true);
    if (start + compressed > offset) throw invalid();
    const localName = new TextDecoder()
      .decode(await file.slice(local + 30, local + 30 + localNameSize).arrayBuffer())
      .replaceAll("\\", "/");
    if (localName !== path) throw invalid();
    scannedBytes += compressed;
    if (scannedBytes > BOX_LIMITS.expandedBytes) throw new BoxImportError("backup_budget");
    const raw = new Uint8Array(await file.slice(start, start + compressed).arrayBuffer());
    const bytes = method === 0 ? raw : await decompress(raw, "deflate", Math.min(expanded, BOX_LIMITS.fileBytes));
    try {
      if (bytes.length !== expanded || crc32(bytes) !== crc) throw new BoxImportError("box_zip_checksum");
      const prefix = new TextDecoder().decode(bytes.subarray(0, 64)).trimStart();
      if (bytes[0] !== 0xb5 && bytes[0] !== 0x1f && !prefix.startsWith("{") && !prefix.startsWith("ONPKG1:")) continue;
      total += bytes.length;
      if (total > BOX_LIMITS.inputBytes || files.length >= BOX_LIMITS.entries)
        throw new BoxImportError("backup_budget");
      files.push(new Blob([Uint8Array.from(bytes)]));
    } finally {
      raw.fill(0);
      bytes.fill(0);
    }
    progress(i + 1, count);
  }
  if (at !== central.length) throw invalid();
  return parseBoxFiles(files);
}

export async function decompress(
  data: Uint8Array,
  method: "gzip" | "deflate",
  maximum: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [],
    inflate = method === "gzip" ? new Gunzip(ondata) : new Inflate(ondata);
  let size = 0;
  function ondata(chunk: Uint8Array) {
    size += chunk.length;
    if (size > maximum) throw new BoxImportError("box_expanded_budget");
    chunks.push(chunk);
  }
  try {
    for (let i = 0; i < data.length; i += 1024) {
      signal?.throwIfAborted();
      inflate.push(data.subarray(i, i + 1024), i + 1024 >= data.length);
      if (i % 65536 === 0) await new Promise<void>((r) => setTimeout(r, 0));
    }
  } catch (error) {
    if (error instanceof BoxImportError || signal?.aborted) throw error;
    throw new BoxImportError("box_invalid_compression");
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
