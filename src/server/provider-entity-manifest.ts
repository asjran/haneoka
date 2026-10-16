import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { ProviderEntityLocator, ProviderEntityPayload } from "../lib/provider-entity-data";
import { providerEntityHtmlPath } from "../lib/provider-entity-data";

export interface ProviderEntityManifestEntry extends ProviderEntityLocator { sha256: string }
export interface ProviderEntityManifest {
  schema: "haneoka-provider-entities-v1";
  completeCoverage: boolean;
  sourceRevision: string;
  expectedDocuments: number;
  entries: ProviderEntityManifestEntry[];
  errors: Array<{ entry: ProviderEntityLocator; message: string }>;
}
export const providerEntityRoot = () => process.env.PROVIDER_ENTITY_ROOT || path.join(process.cwd(), "data", "provider-static", "entities");
let cachedManifest: { file: string; size: number; mtimeMs: number; value: ProviderEntityManifest } | undefined;
const indexed = new WeakMap<ProviderEntityManifest, Map<string, ProviderEntityManifestEntry>>();
export function providerEntityManifest(allowPartial = process.env.PROVIDER_STATIC_ALLOW_PARTIAL === "1"): ProviderEntityManifest {
  const file = path.join(providerEntityRoot(), "manifest.json");
  if (!fs.existsSync(file)) throw new Error("Provider entity snapshot is missing. Run scripts/build/provider-static.ts before the frontend build.");
  const stat = fs.statSync(file);
  const cached = cachedManifest?.file === file && cachedManifest.size === stat.size && cachedManifest.mtimeMs === stat.mtimeMs ? cachedManifest.value : undefined;
  const manifest = cached || JSON.parse(fs.readFileSync(file, "utf8")) as ProviderEntityManifest;
  if (manifest.schema !== "haneoka-provider-entities-v1" || !Array.isArray(manifest.entries)) throw new Error("Invalid provider entity manifest");
  if (!manifest.completeCoverage && !allowPartial) throw new Error("Provider entity snapshot is incomplete; publication requires complete coverage.");
  cachedManifest = { file, size: stat.size, mtimeMs: stat.mtimeMs, value: manifest };
  return manifest;
}
export function providerEntityManifestEntry(logicalPath: string, allowPartial = false): ProviderEntityManifestEntry | undefined {
  const manifest = providerEntityManifest(allowPartial);
  let entries = indexed.get(manifest);
  if (!entries) { entries = new Map(manifest.entries.map(entry => [providerEntityHtmlPath(entry), entry])); indexed.set(manifest, entries); }
  return entries.get(logicalPath.replace(/\.json$/u, ".html"));
}
export function readProviderEntityPayload(entry: ProviderEntityManifestEntry): ProviderEntityPayload {
  if (!/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new TypeError("Invalid provider entity hash");
  const file = path.join(providerEntityRoot(), "payloads", entry.sha256.slice(0, 2), `${entry.sha256}.json.gz`);
  const body = gunzipSync(fs.readFileSync(file));
  if (createHash("sha256").update(body).digest("hex") !== entry.sha256) throw new Error(`Provider entity hash mismatch ${entry.id}`);
  const payload = JSON.parse(body.toString("utf8")) as ProviderEntityPayload;
  if (payload.schema !== "haneoka-provider-entity-v1" || payload.provider !== entry.provider || payload.locale !== entry.locale || payload.resource !== entry.resource || payload.id !== entry.id || payload.section !== entry.section || payload.cardId !== entry.cardId) throw new Error(`Provider entity identity mismatch ${entry.id}`);
  return payload;
}
export function storeProviderEntityPayload(payload: ProviderEntityPayload): ProviderEntityManifestEntry {
  const body = Buffer.from(JSON.stringify(payload));
  const sha256 = createHash("sha256").update(body).digest("hex");
  const file = path.join(providerEntityRoot(), "payloads", sha256.slice(0, 2), `${sha256}.json.gz`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    if (createHash("sha256").update(gunzipSync(fs.readFileSync(file))).digest("hex") !== sha256) throw new Error(`Provider entity hash mismatch ${payload.id}`);
  } else fs.writeFileSync(file, gzipSync(body, { level: 6 }), { flag: "wx" });
  return { provider: payload.provider, locale: payload.locale, resource: payload.resource, id: payload.id, ...(payload.section ? { section: payload.section } : {}), ...(payload.cardId ? { cardId: payload.cardId } : {}), sha256 };
}
