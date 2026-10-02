/** Explicit pinned-reference build export; no inventory/profile defaults or score formula. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import type { evaluateMetaReference } from "../../src/lib/team-builder/data/meta-reference.ts";
import type { MetaReferenceChart, MetaReferenceProfile } from "../../src/lib/team-builder/data/meta-reference.ts";
import type { TeamBuilderData } from "../../src/lib/team-builder/data.ts";

const requestFile = process.argv[2];
const bytes = requestFile ? readFileSync(requestFile) : readFileSync(0);
if (bytes.byteLength > 64 * 1024 * 1024) throw new RangeError("meta-reference-request-bytes");
const request = JSON.parse(bytes.toString("utf8")) as {
  schema: string;
  data: TeamBuilderData;
  profile: MetaReferenceProfile;
  charts: MetaReferenceChart[];
  maxMilliseconds: number;
  calculatedAt?: string;
};
if (request.schema !== "haneoka-meta-reference-request-v1") throw new Error("Meta reference request schema");
const entry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/lib/team-builder/data/meta-reference.ts",
);
const bundle = buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent",
});
const source = bundle.outputFiles?.[0]?.text;
if (!source) throw new Error("Meta reference core bundle missing");
const compiled: { exports: { evaluateMetaReference?: typeof evaluateMetaReference } } = { exports: {} };
new Function("module", "exports", "require", source)(compiled, compiled.exports, createRequire(import.meta.url));
if (!compiled.exports.evaluateMetaReference) throw new Error("Meta reference core entry missing");
const result = await compiled.exports.evaluateMetaReference(request.data, request.profile, request.charts, {
  maxMilliseconds: request.maxMilliseconds,
  calculatedAt: request.calculatedAt,
});
process.stdout.write(JSON.stringify(result) + "\n");
