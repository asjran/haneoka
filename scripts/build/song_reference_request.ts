/** Materialize a fixed recipe from one explicit release directory.
 * The R2 wrapper stages only the selected catalogue/Master/chart files here.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import type { openPinnedReleaseCatalog } from "../../src/server/release-catalog.ts";
import type { teamBuilderDataResponse } from "../../src/lib/team-builder/data/response.ts";
import type { readRuntimeRulesDocument } from "../../src/lib/team-builder/data/runtime-rules.ts";
import type { materializeReferenceRequest, CanonicalReferenceChart, TeamReferenceRecipe } from "../../src/lib/team-builder/data/reference-request.ts";
import type { TeamBuilderData } from "../../src/lib/team-builder/data.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]!, value = process.argv[i + 1];
  if (!key.startsWith("--") || !value || args.has(key) ||
      !["--release-root", "--server", "--release", "--source", "--recipe", "--calculated-at", "--max-ms", "--output"].includes(key))
    throw new Error(`Invalid materializer argument:${key}`);
  args.set(key, value);
}
const required = (key: string) => {
  const value = args.get(key);
  if (!value) throw new Error(`Missing materializer argument:${key}`);
  return value;
};
const root = fs.realpathSync(required("--release-root"));
const identity = { server: required("--server"), releaseId: required("--release"), sourceId: required("--source") };
const recipe = JSON.parse(fs.readFileSync(required("--recipe"), "utf8")) as TeamReferenceRecipe;
const calculatedAt = required("--calculated-at");
const maximum = Number(args.get("--max-ms") ?? "60000");
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundle = buildSync({
  stdin: {
    contents: [
      'export { openPinnedReleaseCatalog } from "./src/server/release-catalog.ts";',
      'export { teamBuilderDataResponse } from "./src/lib/team-builder/data/response.ts";',
      'export { readRuntimeRulesDocument } from "./src/lib/team-builder/data/runtime-rules.ts";',
      'export { materializeReferenceRequest } from "./src/lib/team-builder/data/reference-request.ts";',
    ].join("\n"),
    resolveDir: repository, loader: "ts",
  },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
});
const compiled: { exports: {
  openPinnedReleaseCatalog: typeof openPinnedReleaseCatalog;
  teamBuilderDataResponse: typeof teamBuilderDataResponse;
  readRuntimeRulesDocument: typeof readRuntimeRulesDocument;
  materializeReferenceRequest: typeof materializeReferenceRequest;
} } = { exports: {} as never };
new Function("module", "exports", "require", bundle.outputFiles![0]!.text)(compiled, compiled.exports, createRequire(import.meta.url));
const api = compiled.exports;
const manifest = JSON.parse(fs.readFileSync(path.join(root, "release.json"), "utf8")) as {
  schema: string; server: string; sourceId: string;
  entries: { path: string; bytes: number; sha256: string }[];
};
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  return JSON.stringify(value);
};
const digest = createHash("sha256").update(canonicalJson({
  schema: manifest.schema, server: manifest.server, sourceId: manifest.sourceId, entries: manifest.entries,
}) + "\n").digest("hex");
if (identity.releaseId !== `r-${digest.slice(0, 20)}`) throw new Error("Materializer release manifest content mismatch");
const entries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
const verified = new Set<string>();
function readBytes(relative: string, missingAllowed = false): Buffer | null {
  if (!relative || relative.startsWith("/") || relative.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("Invalid materializer release path");
  const entry = entries.get(relative), file = path.join(root, relative);
  if (!entry || !fs.existsSync(file)) {
    if (missingAllowed) return null;
    throw new Error(`Materializer release file missing:${relative}`);
  }
  const real = fs.realpathSync(file);
  if (!real.startsWith(root + path.sep)) throw new Error("Materializer release file escapes root");
  if (entry.bytes > (relative.startsWith("assets/") ? 2 : 64) * 1024 * 1024)
    throw new Error(`Materializer file exceeds byte limit:${relative}`);
  const bytes = fs.readFileSync(real);
  if (!verified.has(relative)) {
    if (bytes.byteLength !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error(`Materializer file hash mismatch:${relative}`);
    verified.add(relative);
  }
  return bytes;
}
readBytes("api/v1/catalog/manifest.json");
const catalog = api.openPinnedReleaseCatalog(root);
if (catalog.identity.server !== identity.server || catalog.identity.releaseId !== identity.releaseId || catalog.identity.sourceId !== identity.sourceId)
  throw new Error("Materializer release identity mismatch");
const verifiedEntityResources = new Set<string>();
const response = await api.teamBuilderDataResponse({
  identity,
  readCollection(resource) {
    const storage = catalog.manifest.resources[resource];
    if (!storage) throw new Error(`Materializer catalogue resource missing:${resource}`);
    readBytes(storage.index);
    return catalog.readCollection(resource);
  },
  readEntity(resource, id) {
    const storage = catalog.manifest.resources[resource]?.entities;
    if (storage && !verifiedEntityResources.has(resource)) {
      for (const shard of storage.shards) readBytes(`${storage.prefix}${shard}.json`);
      verifiedEntityResources.add(resource);
    }
    return catalog.readEntity(resource, id);
  },
  readRuntimeRules: () => api.readRuntimeRulesDocument(identity, async (_pin, table) => {
    const bytes = readBytes(`objects/master/${table}.json`, true);
    return bytes ? JSON.parse(bytes.toString("utf8")) : null;
  }),
});
const data = await response.json() as TeamBuilderData;
const files: Record<string, string> = {};
const canonical = new Map<string, CanonicalReferenceChart | null>();
for (const [songId, song] of Object.entries(data.songs)) {
  if (!Array.isArray(song.difficulty)) throw new Error(`Materializer difficulty collection missing:${songId}`);
  for (const row of song.difficulty as Record<string, unknown>[]) {
    const key = `${songId}:${row.difficulty}`;
    if (canonical.has(key)) throw new Error(`Materializer duplicate catalogue difficulty:${key}`);
    canonical.set(key, null);
    const prefix = `/assets/${identity.server}/`;
    if (typeof row.file !== "string" || !row.file.startsWith(prefix)) continue;
    const relative = `assets/${row.file.slice(prefix.length)}`;
    if (readBytes(relative, true)) files[key] = path.join(root, relative);
  }
}
// One invocation of the canonical build converter; missing files retain rows.
if (Object.keys(files).length) {
  const converted = spawnSync(process.execPath, [path.join(repository, "scripts/build/song_metrics.ts")], {
    input: JSON.stringify(files), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000,
  });
  if (converted.status !== 0) throw new Error(`Canonical chart conversion failed:${converted.stderr?.slice(-2048)}`);
  const charts = JSON.parse(converted.stdout) as Record<string, Omit<CanonicalReferenceChart, "identity">>;
  if (Object.keys(charts).length !== Object.keys(files).length) throw new Error("Canonical converter coverage mismatch");
  for (const [key, chart] of Object.entries(charts)) {
    if (!Object.hasOwn(files, key)) throw new Error("Canonical converter returned an unknown chart");
    canonical.set(key, { ...chart, identity: { ...identity } });
  }
}
const request = api.materializeReferenceRequest(data, recipe, canonical, { calculatedAt, maxMilliseconds: maximum });
const json = JSON.stringify(request) + "\n";
if (Buffer.byteLength(json) > 64 * 1024 * 1024) throw new Error("Materialized request exceeds byte limit");
const output = args.get("--output");
if (output) {
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, json);
  fs.renameSync(temporary, output);
  process.stdout.write(JSON.stringify({ output: path.resolve(output), ...request.materialization,
    verifiedFiles: verified.size, requestSHA256: createHash("sha256").update(json).digest("hex") }) + "\n");
} else process.stdout.write(json);
