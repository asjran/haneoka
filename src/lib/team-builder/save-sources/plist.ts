import { BoxImportError } from "@haneoka/game-data-exporter";
export type Plist = null | boolean | number | string | Uint8Array | PlistUid | Plist[] | { [key: string]: Plist };
export class PlistUid {
  constructor(readonly index: number) {}
}
const invalid = () => new BoxImportError("backup_invalid");
export function plistObject(value: Plist | undefined): Record<string, Plist> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Uint8Array ||
    value instanceof PlistUid
  )
    throw invalid();
  return value;
}
export function plistBytes(value: Plist | undefined): Uint8Array {
  if (!(value instanceof Uint8Array)) throw invalid();
  return value;
}
export function parsePlist(bytes: Uint8Array): Plist {
  if (bytes.length > 16 * 1024 * 1024) throw invalid();
  const decode = new TextDecoder();
  if (decode.decode(bytes.subarray(0, 8)) !== "bplist00") return xmlPlist(decode.decode(bytes));
  if (bytes.length < 40) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const uint = (at: number, count: number): number => {
    if (count < 1 || count > 8 || at < 0 || at + count > bytes.length) throw invalid();
    let n = 0;
    for (let i = 0; i < count; i++) n = n * 256 + bytes[at + i]!;
    if (!Number.isSafeInteger(n)) throw invalid();
    return n;
  };
  const trailer = bytes.length - 32,
    offsetSize = bytes[trailer + 6]!,
    refSize = bytes[trailer + 7]!;
  const count = uint(trailer + 8, 8),
    root = uint(trailer + 16, 8),
    table = uint(trailer + 24, 8);
  if (!count || count > 100000 || table + count * offsetSize > trailer) throw invalid();
  const cache = new Map<number, Plist>(),
    active = new Set<number>();
  const read = (id: number, depth = 0): Plist => {
    if (id >= count || depth > 48 || active.has(id)) throw invalid();
    if (cache.has(id)) return cache.get(id)!;
    active.add(id);
    let at = uint(table + id * offsetSize, offsetSize);
    if (at < 8 || at >= table) throw invalid();
    const tag = bytes[at++]!,
      kind = tag >> 4;
    let length = tag & 15;
    if ([4, 5, 6, 10, 13].includes(kind) && length === 15) {
      const marker = bytes[at++]!;
      if (marker >> 4 !== 1 || (marker & 15) > 3) throw invalid();
      const size = 2 ** (marker & 15);
      length = uint(at, size);
      at += size;
    }
    const bound = (size: number) => {
      if (at + size > table) throw invalid();
    };
    let value: Plist;
    switch (kind) {
      case 0:
        if (tag === 0) value = null;
        else if (tag === 8 || tag === 9) value = tag === 9;
        else throw invalid();
        break;
      case 1:
        value = uint(at, 2 ** length);
        break;
      case 2:
        bound(2 ** length);
        if (length === 2) value = view.getFloat32(at);
        else if (length === 3) value = view.getFloat64(at);
        else throw invalid();
        break;
      case 3:
        bound(8);
        value = view.getFloat64(at) + 978307200;
        break;
      case 4:
        bound(length);
        value = bytes.slice(at, at + length);
        break;
      case 5:
        bound(length);
        value = decode.decode(bytes.subarray(at, at + length));
        break;
      case 6:
        bound(length * 2);
        value = new TextDecoder("utf-16be").decode(bytes.subarray(at, at + length * 2));
        break;
      case 8:
        value = new PlistUid(uint(at, length + 1));
        break;
      case 10:
        bound(length * refSize);
        value = Array.from({ length }, (_, i) => read(uint(at + i * refSize, refSize), depth + 1));
        break;
      case 13: {
        bound(length * refSize * 2);
        const object: Record<string, Plist> = Object.create(null);
        for (let i = 0; i < length; i++) {
          const key = read(uint(at + i * refSize, refSize), depth + 1);
          if (typeof key !== "string") throw invalid();
          object[key] = read(uint(at + (i + length) * refSize, refSize), depth + 1);
        }
        value = object;
        break;
      }
      default:
        throw invalid();
    }
    active.delete(id);
    cache.set(id, value);
    return value;
  };
  return read(root);
}
function xmlPlist(xml: string): Plist {
  // Apple's XML plist has a fixed vocabulary. No external entity resolution.
  const tokens =
    xml
      .replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g, "")
      .match(/<[^>]+>|[^<]+/g)
      ?.filter((t) => t.trim()) ?? [];
  let at = 0,
    nodes = 0;
  const entity = (s: string) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code: string) =>
      code.startsWith("#")
        ? String.fromCodePoint(parseInt(code.slice(code[1] === "x" ? 2 : 1), code[1] === "x" ? 16 : 10))
        : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[code] ?? ""),
    );
  const read = (depth = 0): Plist => {
    if (depth > 48 || ++nodes > 100000) throw invalid();
    const token = tokens[at++] ?? "",
      match = /^<(\w+)(?:\s[^>]*)?\s*(\/?)>$/.exec(token);
    if (!match) throw invalid();
    const tag = match[1]!,
      empty = token.endsWith("/>");
    const close = () => {
      if (tokens[at++] !== `</${tag}>`) throw invalid();
    };
    if (tag === "plist") {
      const v = read(depth + 1);
      close();
      return v;
    }
    if (tag === "true" || tag === "false") {
      if (!empty) close();
      return tag === "true";
    }
    if (tag === "dict") {
      const v: Record<string, Plist> = Object.create(null);
      if (!empty) {
        while (tokens[at] !== "</dict>") {
          if (tokens[at] !== "<key>" && tokens[at] !== "<key/>") throw invalid();
          const key = read(depth + 1);
          if (typeof key !== "string") throw invalid();
          v[key] = read(depth + 1);
        }
        close();
      }
      return v;
    }
    if (tag === "array") {
      const v: Plist[] = [];
      if (!empty) {
        while (tokens[at] !== "</array>") v.push(read(depth + 1));
        close();
      }
      return v;
    }
    let text = "";
    if (!empty) {
      if (!tokens[at]?.startsWith("<")) text = tokens[at++] ?? "";
      close();
    }
    if (tag === "key" || tag === "string") return entity(text);
    if (tag === "data") {
      try {
        return Uint8Array.from(atob(text.replace(/\s/g, "")), (c) => c.charCodeAt(0));
      } catch {
        throw invalid();
      }
    }
    if (tag === "integer" || tag === "real") {
      const n = Number(text);
      if (!Number.isFinite(n) || (tag === "integer" && !Number.isSafeInteger(n))) throw invalid();
      return n;
    }
    if (tag === "date") {
      const n = Date.parse(text) / 1000;
      if (!Number.isFinite(n)) throw invalid();
      return n;
    }
    throw invalid();
  };
  const value = read();
  if (at !== tokens.length) throw invalid();
  return value;
}
