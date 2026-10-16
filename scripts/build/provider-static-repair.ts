import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { providerEntityHtmlPath, type ProviderEntityLocator } from "../../src/lib/provider-entity-data";
import { createProviderSourceCache } from "../../src/server/provider-source-cache";
import { createProviderProjector, PROVIDER_STORY_SECTIONS } from "../../src/server/provider-projector";
import { LOCALES } from "../../src/i18n/locales";
import { providerEntityCollection, providerEntityCollectionResource, providerEntityPayload } from "../../src/server/provider-entity-data";
import { providerEntityManifest, providerEntityRoot, readProviderEntityPayload, storeProviderEntityPayload, type ProviderEntityManifestEntry } from "../../src/server/provider-entity-manifest";

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const log = option("--repair-from-log"), snapshot = option("--snapshot");
if (!log || !snapshot) throw new Error("Repair requires --repair-from-log FILE and --snapshot DIR from the original build.");
const base = providerEntityManifest(true);
const failures = new Map<string, ProviderEntityLocator>();
const logText = fs.readFileSync(log, "utf8");
for (const line of logText.slice(0, logText.lastIndexOf("\n") + 1).split("\n")) {
  if (!line.startsWith("{")) continue;
  const record = JSON.parse(line) as { error?: ProviderEntityLocator };
  if (record.error?.id) failures.set(providerEntityHtmlPath(record.error), record.error);
}
const inputs = createProviderSourceCache(snapshot, 1);
const projector = createProviderProjector(inputs.reader);
const entries: ProviderEntityManifestEntry[] = [];
const errors: Array<{ entry: ProviderEntityLocator; message: string }> = [];
for (const entry of failures.values()) {
  try {
    const reference = base.entries.find(value => value.provider === entry.provider && value.locale === entry.locale && providerEntityCollectionResource(value) === providerEntityCollectionResource(entry));
    if (!reference) throw new Error(`Frozen collection snapshot missing: ${providerEntityHtmlPath(entry)}`);
    const collection = providerEntityCollection(readProviderEntityPayload(reference));
    const card = entry.cardId ? await projector.detail({ provider: entry.provider, locale: entry.locale, resource: "cards", id: entry.cardId }, collection) : undefined;
    const detail = await projector.detail(entry, collection);
    inputs.assertConsistent();
    const payload = providerEntityPayload(entry, collection, detail, card);
    entries.push(storeProviderEntityPayload(payload));
    console.log(JSON.stringify({ repaired: providerEntityHtmlPath(entry), commands: Array.isArray(detail.commands) ? detail.commands.length : null, sourceServer: detail.sourceServer }));
  } catch (error) {
    inputs.assertConsistent();
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ entry, message });
    console.error(JSON.stringify({ error: entry, message }));
  }
}
const sourceRevision = createHash("sha256").update(fs.readFileSync("worker/bestdori.ts")).update(fs.readFileSync("scripts/build/provider-static-repair.ts")).digest("hex");
const report = { schema: "haneoka-provider-entity-repairs-v1", sourceRevision, baseSourceRevision: base.sourceRevision, entries, errors, inputs: inputs.report().inputs };
fs.mkdirSync(providerEntityRoot(), { recursive: true });
fs.writeFileSync(path.join(providerEntityRoot(), "repairs.json"), JSON.stringify(report));
if (args.includes("--merge")) {
  const finished = JSON.parse(fs.readFileSync(path.join(providerEntityRoot(), "build-report.json"), "utf8")) as { sourceRevision: string; expectedDocuments: number };
  if (finished.sourceRevision !== base.sourceRevision || finished.expectedDocuments !== base.expectedDocuments) throw new Error("The original complete-matrix build has not finished.");
  const union = new Map(base.entries.map(entry => [providerEntityHtmlPath(entry), entry]));
  for (const entry of entries) union.set(providerEntityHtmlPath(entry), entry);
  const required = new Set<string>();
  for (const provider of ["bestdori", "sekai"] as const) for (const locale of LOCALES) {
    for (const resource of ["songs", ...PROVIDER_STORY_SECTIONS[provider].map(section => `stories/${section}`)]) {
      const reference = base.entries.find(value => value.provider === provider && value.locale === locale && providerEntityCollectionResource(value) === resource);
      if (!reference) throw new Error(`Frozen matrix collection missing: ${provider}/${locale}/${resource}`);
      const collection = providerEntityCollection(readProviderEntityPayload(reference));
      for (const id of Object.keys(collection.document)) {
        const card = provider === "bestdori" && resource === "stories/card";
        const locator: ProviderEntityLocator = { provider, locale, id, resource: resource === "songs" ? "songs" : card ? "cards" : "stories", ...(resource === "songs" || card ? {} : { section: resource.slice("stories/".length) }) };
        const logical = providerEntityHtmlPath(locator);
        required.add(logical);
        if (card) {
          const parent = union.get(logical);
          if (!parent) throw new Error(`Full card missing from matrix: ${logical}`);
          const detail = readProviderEntityPayload(parent).detail;
          for (const episode of (Array.isArray(detail.episodes) ? detail.episodes : []) as Array<Record<string, unknown>>) {
            if (episode.scenarioId) required.add(providerEntityHtmlPath({ provider, locale, resource: "stories", section: "card", id: `card.${episode.resourceSetName || detail.resourceSetName}.${episode.scenarioId}`, cardId: id }));
          }
        }
      }
    }
  }
  const coverageFile = path.join(process.cwd(), ".output", "static-documents", "coverage.json");
  const coverage = JSON.parse(fs.readFileSync(coverageFile, "utf8")) as { expectedDocuments: number; expectedPaths: string[] };
  if (required.size !== base.expectedDocuments || required.size !== coverage.expectedDocuments || coverage.expectedPaths.length !== required.size || coverage.expectedPaths.some(value => !required.has(value))) throw new Error("The coverage plan does not contain the complete frozen catalog matrix.");
  const remainingErrors = base.errors.filter(error => !entries.some(entry => providerEntityHtmlPath(entry) === providerEntityHtmlPath(error.entry)));
  const completeCoverage = errors.length === 0 && remainingErrors.length === 0 && union.size === required.size && [...required].every(value => union.has(value));
  if (!completeCoverage) throw new Error("Provider repair leaves unresolved matrix entries.");
  const merged = { ...base, completeCoverage, entries: [...union.values()].sort((a, b) => providerEntityHtmlPath(a).localeCompare(providerEntityHtmlPath(b), "en")), errors: remainingErrors, repairSourceRevision: sourceRevision };
  const file = path.join(providerEntityRoot(), "manifest.json"), temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(merged)); fs.renameSync(temporary, file);
  fs.writeFileSync(coverageFile, JSON.stringify({ ...coverage, completeCoverage, expectedDocuments: required.size, expectedPaths: [...required].sort() }));
  inputs.saveManifest();
}
// Preview admission adds real repaired records while keeping publication incomplete.
if (args.includes("--preview") && !args.includes("--merge") && !base.completeCoverage) {
  const union = new Map(base.entries.map(entry => [providerEntityHtmlPath(entry), entry]));
  for (const entry of entries) union.set(providerEntityHtmlPath(entry), entry);
  const preview = { ...base, completeCoverage: false, entries: [...union.values()], expectedDocuments: Math.max(base.expectedDocuments, union.size), previewRepairSourceRevision: sourceRevision };
  fs.writeFileSync(path.join(providerEntityRoot(), "manifest.json"), JSON.stringify(preview));
}
console.log(JSON.stringify({ repaired: entries.length, errors: errors.length, sourceRevision }));
if (errors.length) process.exitCode = 1;
