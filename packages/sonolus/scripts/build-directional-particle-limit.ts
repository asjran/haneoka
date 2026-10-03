#!/usr/bin/env node
// Build a bounded side-flick delta from an explicit complete particle baseline.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { limitDirectionalParticles, type DirectionalParticleData } from "./native-particles/limitDirectional.ts";

const [baselineArgument, outputArgument] = process.argv.slice(2);
if (!baselineArgument || !outputArgument)
  throw new Error("Usage: build-directional-particle-limit.ts BASELINE_DIRECTORY OUTPUT_DIRECTORY");
const baselineDirectory = resolve(baselineArgument), output = resolve(outputArgument);
if (baselineDirectory === output) throw new Error("Output must preserve the baseline directory");
const original = readFileSync(resolve(baselineDirectory, "particle.data"));
const texture = readFileSync(resolve(baselineDirectory, "particle.texture.png"));
const hash = (bytes: Buffer, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const baseline = JSON.parse(gunzipSync(original).toString()) as DirectionalParticleData & { width: number; height: number };
if (baseline.effects.length !== 1506 || new Set(baseline.effects.map((e) => e.name)).size !== 1506)
  throw new Error("Expected a complete baseline with 1506 unique effects");
if (texture.readUInt32BE(16) !== baseline.width || texture.readUInt32BE(20) !== baseline.height)
  throw new Error("Baseline texture and metadata dimensions differ");
const result = limitDirectionalParticles(baseline);
if (result.changes.length !== 20) throw new Error("Expected 20 populated Light side-flick effects");
const data = gzipSync(JSON.stringify(result.data), { level: 9 });
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, "particle.data"), data);
writeFileSync(resolve(output, "particle.texture.png"), texture);
const artifact = (bytes: Buffer) => ({ bytes: bytes.length, sha1: hash(bytes, "sha1"), sha256: hash(bytes) });
const report = {
  schema: "our-notes-directional-particle-limit-v1",
  policy: "Half scatter instances per sprite/color family, rounded up; evenly sample emission times; preserve deterministic groups",
  baselineDirectory,
  baseline: { data: artifact(original), texture: artifact(texture) },
  artifacts: { "particle.data": artifact(data), "particle.texture.png": artifact(texture) },
  sourceHashes: Object.fromEntries([import.meta.url, new URL("./native-particles/limitDirectional.ts", import.meta.url).href]
    .map((url) => [new URL(url).pathname, hash(readFileSync(new URL(url)))])),
  effects: result.data.effects.length,
  unchangedEffects: result.data.effects.length - result.changes.length,
  textureByteIdentical: true,
  changes: result.changes,
};
writeFileSync(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ artifacts: report.artifacts, changedEffects: result.changes.length, unchangedEffects: report.unchangedEffects }));
