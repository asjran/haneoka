import { aeskw, cbc } from "@noble/ciphers/aes.js";
import { BoxImportError } from "@haneoka/game-data-exporter";
import { plistBytes, type Plist } from "./plist";
const invalid = () => new BoxImportError("backup_invalid");
const number = (bytes: Uint8Array | undefined) => {
  if (!bytes || bytes.length !== 4) throw invalid();
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
};
async function derive(password: Uint8Array, salt: Uint8Array, iterations: number, hash: string) {
  if (!iterations || iterations > 20000000 || salt.length > 1024) throw invalid();
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", salt: Uint8Array.from(salt), iterations, hash }, key, 256),
  );
}
export function unwrap(key: Uint8Array, wrapped: Uint8Array): Uint8Array {
  try {
    return aeskw(key).decrypt(wrapped);
  } catch {
    throw new BoxImportError("backup_password");
  }
}
export function decryptBackup(key: Uint8Array, bytes: Uint8Array): Uint8Array {
  if (!bytes.length || bytes.length % 16) throw invalid();
  return cbc(key, new Uint8Array(16), { disablePadding: true }).decrypt(bytes);
}
export async function unlockBackup(
  manifest: Record<string, Plist>,
  password: string,
): Promise<Map<number, Uint8Array>> {
  const bag = plistBytes(manifest.BackupKeyBag),
    attrs = new Map<string, Uint8Array>(),
    entries: Map<string, Uint8Array>[] = [];
  const view = new DataView(bag.buffer, bag.byteOffset, bag.byteLength);
  let current = attrs;
  for (let at = 0; at < bag.length;) {
    if (at + 8 > bag.length) throw invalid();
    const tag = new TextDecoder().decode(bag.subarray(at, at + 4)),
      size = view.getUint32(at + 4);
    if (at + 8 + size > bag.length) throw invalid();
    if (tag === "UUID" && attrs.has("UUID")) {
      current = new Map();
      entries.push(current);
    }
    current.set(tag, bag.subarray(at + 8, at + 8 + size));
    at += 8 + size;
  }
  let secret = new TextEncoder().encode(password),
    key: Uint8Array | undefined;
  const keys = new Map<number, Uint8Array>();
  try {
    if (attrs.has("DPSL")) {
      const next = await derive(secret, attrs.get("DPSL")!, number(attrs.get("DPIC")), "SHA-256");
      secret.fill(0);
      secret = next;
    }
    key = await derive(secret, attrs.get("SALT") ?? new Uint8Array(), number(attrs.get("ITER")), "SHA-1");
    for (const entry of entries) {
      if (!entry.has("WPKY") || !entry.has("CLAS") || !entry.has("WRAP") || !(number(entry.get("WRAP")) & 2)) continue;
      keys.set(number(entry.get("CLAS")), unwrap(key, entry.get("WPKY")!));
    }
    if (!keys.size) throw new BoxImportError("backup_password");
    return keys;
  } catch (error) {
    for (const value of keys.values()) value.fill(0);
    throw error;
  } finally {
    secret.fill(0);
    key?.fill(0);
  }
}
