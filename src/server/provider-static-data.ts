import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { CatalogProvider, ProviderCollectionPayload } from "../lib/provider-page-data";

const dataRoot = process.env.PROVIDER_STATIC_DATA_ROOT || path.join(process.cwd(), "data", "provider-static", "generated-data");
const files = new Map<string, string>();
const registered = new WeakMap<object, string>();
const documents = new Map<string, { value: unknown; bytes: number }>();
let documentBytes = 0;
export function registerProviderStaticData(value: unknown): string {
  if (value && typeof value === "object") {
    const previous = registered.get(value);
    if (previous) return previous;
  }
  const body = JSON.stringify(value);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const file = path.join(dataRoot, sha256.slice(0, 2), `${sha256}.json`);
  if (!files.has(sha256)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file);
      if (existing.length !== Buffer.byteLength(body) || createHash("sha256").update(existing).digest("hex") !== sha256) throw new Error(`Invalid provider static data ${sha256}`);
    } else fs.writeFileSync(file, body, { flag: "wx" });
    files.set(sha256, file);
  }
  const url = `/provider-static/data/${sha256}.json`;
  if (value && typeof value === "object") registered.set(value, url);
  return url;
}
export function readProviderStaticData<T = unknown>(url: string): T {
  const match = /^\/provider-static\/data\/([a-f0-9]{64})\.json$/u.exec(url);
  if (!match) throw new TypeError("Invalid provider static data URL");
  const sha256 = match[1]!, file = files.get(sha256) || path.join(dataRoot, sha256.slice(0, 2), `${sha256}.json`);
  const cached = documents.get(sha256);
  if (cached) { documents.delete(sha256); documents.set(sha256, cached); return cached.value as T; }
  const body = fs.readFileSync(file);
  if (createHash("sha256").update(body).digest("hex") !== sha256) throw new Error(`Invalid provider static data ${sha256}`);
  files.set(sha256, file);
  const value = JSON.parse(body.toString("utf8")) as T;
  documents.set(sha256, { value, bytes: body.length }); documentBytes += body.length;
  while (documentBytes > 64 * 1024 * 1024 || documents.size > 32) {
    const oldest = documents.keys().next().value!;
    documentBytes -= documents.get(oldest)!.bytes; documents.delete(oldest);
  }
  return value;
}
export function providerStaticDataEntries() {
  if (fs.existsSync(dataRoot)) for (const entry of fs.readdirSync(dataRoot, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name)) files.set(entry.name.slice(0, -5), path.join(entry.parentPath, entry.name));
  }
  return [...files].map(([sha256, file]) => ({ sha256, file }));
}

let collectionSnapshots: Map<string, string | null> | undefined;
/** Read a complete frozen collection by its own identity, including empty catalogues. */
export function readProviderStaticCollection(provider: CatalogProvider, locale: string, resource: string): ProviderCollectionPayload | undefined {
  const key = (provider: string, locale: string, resource: string) => JSON.stringify([provider, locale, resource]);
  if (!collectionSnapshots) {
    const snapshots = new Map<string, string | null>();
    try {
      for (const { sha256 } of providerStaticDataEntries()) {
        const url = `/provider-static/data/${sha256}.json`;
        const value = readProviderStaticData<ProviderCollectionPayload>(url);
        if (value?.schema !== "haneoka-provider-collection-v1") continue;
        const identity = key(value.provider, value.locale, value.resource);
        const previous = snapshots.get(identity);
        snapshots.set(identity, snapshots.has(identity) && previous !== url ? null : url);
      }
      collectionSnapshots = snapshots;
    } catch {
      collectionSnapshots = new Map();
    }
  }
  const url = collectionSnapshots.get(key(provider, locale, resource));
  return url ? readProviderStaticData<ProviderCollectionPayload>(url) : undefined;
}
