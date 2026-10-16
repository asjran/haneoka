import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { LOCALES, type Locale } from "../../src/i18n/locales";
import { providerEntityHtmlPath, type ProviderEntityLocator, type ProviderEntityPayload } from "../../src/lib/provider-entity-data";
import type { CatalogProvider, ProviderCollectionPayload } from "../../src/lib/provider-page-data";
import { createProviderSourceCache } from "../../src/server/provider-source-cache";
import { createProviderProjector, PROVIDER_STORY_SECTIONS } from "../../src/server/provider-projector";
import { providerEntityPayload } from "../../src/server/provider-entity-data";
import { providerEntityRoot, type ProviderEntityManifest, type ProviderEntityManifestEntry } from "../../src/server/provider-entity-manifest";

const args = process.argv.slice(2);
function option(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] || "";
}
if (args.includes("--help")) {
  console.log("provider-static [--snapshot DIR] [--concurrency 4] [--sample-per-section N]\nThe default produces every locale/entity. Sample snapshots are marked incomplete and cannot be published.");
  process.exit(0);
}
const sample = Number(option("--sample-per-section", "0"));
const concurrency = Number(option("--concurrency", "4"));
if (!Number.isSafeInteger(sample) || sample < 0 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new TypeError("Invalid provider build limits");
const inputRoot = option("--snapshot", process.env.PROVIDER_STATIC_SNAPSHOT || path.join(process.cwd(), "data", "provider-static", "snapshots", new Date().toISOString().slice(0, 10)));
const root = providerEntityRoot();
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function atomic(file: string, value: string | Uint8Array) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, value, { flag: "wx" });
  fs.renameSync(temporary, file);
}
const sources = ["worker/bestdori.ts", "worker/sekai.ts", "worker/provider-source.ts", "src/server/provider-projector.ts", "src/server/provider-entity-data.ts", "src/lib/provider-entity-data.ts", "scripts/build/provider-static.ts"];
const packageRoot = fs.realpathSync(path.join(process.cwd(), "node_modules", "@haneoka", "bestdori"));
for (const file of fs.readdirSync(path.join(packageRoot, "dist"), { recursive: true, withFileTypes: true })) if (file.isFile()) sources.push(path.join(file.parentPath, file.name));
const inputs = createProviderSourceCache(inputRoot, concurrency);
const sourceRevision = hash(`${inputs.snapshotId}\n${sources.sort().map(file => `${file}\0${hash(fs.readFileSync(path.resolve(file)))}`).join("\n")}`);
const projector = createProviderProjector(inputs.reader);
const collections = new Map<string, ProviderCollectionPayload>();
const entries: ProviderEntityManifestEntry[] = [];
const expected = new Map<string, ProviderEntityLocator>();
const errors: ProviderEntityManifest["errors"] = [];
let resumed = 0, produced = 0;
const identity = (entry: ProviderEntityLocator) => providerEntityHtmlPath(entry);
const receiptFile = (entry: ProviderEntityLocator) => { const key = hash(`${sourceRevision}\0${identity(entry)}`); return path.join(root, "receipts", key.slice(0, 2), `${key}.json`); };
const bodyFile = (sha256: string) => path.join(root, "payloads", sha256.slice(0, 2), `${sha256}.json.gz`);
function locator(value: ProviderEntityLocator): ProviderEntityLocator {
  return { provider: value.provider, locale: value.locale, resource: value.resource, id: value.id, ...(value.section ? { section: value.section } : {}), ...(value.cardId ? { cardId: value.cardId } : {}) };
}
async function produce(entry: ProviderEntityLocator, collection: ProviderCollectionPayload, card?: Record<string, unknown>): Promise<ProviderEntityPayload | undefined> {
  entry = locator(entry);
  try {
    const previous = expected.get(identity(entry));
    if (previous && previous.cardId !== entry.cardId) throw new Error(`Provider entity path has conflicting card contexts: ${identity(entry)}`);
    expected.set(identity(entry), entry);
    const receipt = receiptFile(entry);
    if (fs.existsSync(receipt)) {
      const stored = JSON.parse(fs.readFileSync(receipt, "utf8")) as ProviderEntityManifestEntry;
      const body = gunzipSync(fs.readFileSync(bodyFile(stored.sha256)));
      if (hash(body) !== stored.sha256) throw new Error(`Provider build receipt hash mismatch ${entry.id}`);
      const payload = JSON.parse(body.toString("utf8")) as ProviderEntityPayload;
      if (identity(payload) !== identity(entry) || payload.cardId !== entry.cardId) throw new Error(`Provider build receipt identity mismatch ${entry.id}`);
      entries.push({ ...entry, sha256: stored.sha256 }); resumed++;
      return payload;
    }
    const detail = await projector.detail(entry, collection);
    inputs.assertConsistent();
    const payload = providerEntityPayload(entry, collection, detail, card);
    const body = JSON.stringify(payload), sha256 = hash(body);
    const target = bodyFile(sha256);
    if (!fs.existsSync(target)) atomic(target, gzipSync(body, { level: 6 }));
    const record = { ...entry, sha256 };
    atomic(receipt, JSON.stringify(record));
    entries.push(record); produced++;
    return payload;
  } catch (error) {
    inputs.assertConsistent();
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ entry, message });
    console.error(JSON.stringify({ error: entry, message }));
    return undefined;
  }
}
async function runGroups(groups: Array<() => Promise<void>>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, async () => {
    while (cursor < groups.length) { const current = cursor++; await groups[current]!(); }
  }));
}
function collectionKey(provider: CatalogProvider, locale: Locale, resource: string) { return `${provider}/${locale}/${resource}`; }
for (const provider of ["bestdori", "sekai"] as const) {
  for (const resource of ["songs", ...PROVIDER_STORY_SECTIONS[provider].map(section => `stories/${section}`)]) {
    for (const locale of LOCALES) {
      const collection = await projector.collection(provider, locale, resource);
      collections.set(collectionKey(provider, locale, resource), collection);
      console.log(JSON.stringify({ collection: collectionKey(provider, locale, resource), count: Object.keys(collection.document).length }));
    }
  }
}
const planned: Array<() => Promise<void>> = [];
for (const provider of ["bestdori", "sekai"] as const) {
  // Card records enumerate their authored episodes before story generation.
  const resources = [...(provider === "bestdori" ? ["stories/card"] : []), "songs", ...PROVIDER_STORY_SECTIONS[provider].filter(section => !(provider === "bestdori" && section === "card")).map(section => `stories/${section}`)];
  for (const resource of resources) {
    const ids = [...new Set(LOCALES.flatMap(locale => Object.keys(collections.get(collectionKey(provider, locale, resource))!.document)))];
    for (const id of sample ? ids.slice(0, sample) : ids) {
      planned.push(async () => {
        for (const locale of LOCALES) {
          const collection = collections.get(collectionKey(provider, locale, resource))!;
          if (!(id in collection.document)) continue;
          const isCard = provider === "bestdori" && resource === "stories/card";
          const entry: ProviderEntityLocator = { provider, locale, id, resource: resource === "songs" ? "songs" : isCard ? "cards" : "stories", ...(resource === "songs" || isCard ? {} : { section: resource.slice("stories/".length) }) };
          const payload = await produce(entry, collection);
          if (isCard && payload) {
            const card = payload.detail;
            for (const episode of (Array.isArray(card.episodes) ? card.episodes : []) as Array<Record<string, unknown>>) {
              if (!episode.scenarioId) continue;
              const storyId = `card.${episode.resourceSetName || card.resourceSetName}.${episode.scenarioId}`;
              await produce({ provider, locale, resource: "stories", section: "card", id: storyId, cardId: id }, collection, card);
            }
          }
        }
        if ((produced + resumed) % 100 === 0) console.log(JSON.stringify({ produced, resumed, errors: errors.length, requests: inputs.report().requests, hits: inputs.report().hits }));
      });
    }
  }
}
const progress = setInterval(() => {
  inputs.saveManifest();
  const report = { at: new Date().toISOString(), produced, resumed, errors: errors.length, pendingGroups: planned.length, requests: inputs.report().requests, hits: inputs.report().hits, activeRequests: inputs.report().active };
  atomic(path.join(root, "progress.json"), JSON.stringify(report));
  console.log(JSON.stringify(report));
}, 30_000);
try { await runGroups(planned); } finally { clearInterval(progress); }
inputs.assertConsistent();
inputs.saveManifest();
const completeCoverage = sample === 0 && errors.length === 0 && entries.length === expected.size;
const manifest: ProviderEntityManifest = { schema: "haneoka-provider-entities-v1", sourceRevision, completeCoverage, expectedDocuments: expected.size, entries: entries.sort((a, b) => identity(a).localeCompare(identity(b), "en")), errors };
atomic(path.join(root, "manifest.json"), JSON.stringify(manifest));
const coverage = { completeCoverage, expectedDocuments: expected.size, expectedPaths: [...expected.keys()].sort() };
atomic(path.join(process.cwd(), ".output", "static-documents", "coverage.json"), JSON.stringify(coverage));
atomic(path.join(root, "build-report.json"), JSON.stringify({ ...inputs.report(), produced, resumed, completeCoverage, expectedDocuments: expected.size, sourceRevision, errors }, null, 2));
console.log(JSON.stringify({ completeCoverage, expectedDocuments: expected.size, produced, resumed, errors: errors.length, sourceRevision }));
if (errors.length) process.exitCode = 1;
