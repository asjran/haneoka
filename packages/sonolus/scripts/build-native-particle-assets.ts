#!/usr/bin/env node

// Particle-only build; can validate a bounded sample without rebuilding skins,
// sound packs, engine facets, or the site.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { compileNativeParticles, NATIVE_EFFECT_PROFILES } from "./native-particles/compile.ts";
import { mergeNativeParticleDelta, type ParticleData } from "./native-particles/merge.ts";
import { resolveSonolusReleaseWorkspace } from "../src/server/releaseWorkspace.ts";
import { validateSonolusInputProvenance } from "../src/server/sonolusProvenance.ts";

const destination = process.argv[2];
if (!destination)
  throw new Error(
    "Usage: node build-native-particle-assets.ts OUTPUT_DIRECTORY [EXACT_EFFECT_NAME_WITHOUT_PLANE | --light-delta BASELINE_DIRECTORY]",
  );
const isDelta = process.argv[3] === "--light-delta";
const baselineDirectory = isDelta ? process.argv[4] : undefined;
if (isDelta && !baselineDirectory) throw new Error("--light-delta requires a complete baseline directory");
if (baselineDirectory && resolve(destination) === resolve(baselineDirectory))
  throw new Error("Light delta output must preserve the baseline directory");
const only = isDelta ? undefined : process.argv[3];
const root = resolve(process.env.OUR_NOTES_ROOT || process.cwd());
const workspace = resolveSonolusReleaseWorkspace(process.env.RELEASE_SERVER || "intl", root);
const provenance = validateSonolusInputProvenance(workspace, root);
const hash = (bytes: Buffer, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const baselineBytes = baselineDirectory ? readFileSync(resolve(baselineDirectory, "particle.data")) : undefined;
const baselinePng = baselineDirectory ? readFileSync(resolve(baselineDirectory, "particle.texture.png")) : undefined;
const baseline = baselineBytes ? (JSON.parse(gunzipSync(baselineBytes).toString()) as ParticleData) : undefined;
const baselineReport = baselineDirectory
  ? JSON.parse(readFileSync(resolve(baselineDirectory, "native-particle-report.json"), "utf8"))
  : undefined;
if (
  baseline &&
  (baseline.effects.length !== 1506 ||
    baselineReport.partial ||
    baselineReport.sourceId !== provenance.sourceId ||
    baselineReport.releaseId !== provenance.releaseId)
)
  throw new Error("Light delta requires a complete baseline from the current source/release");
if (
  baseline &&
  (baselineReport.artifacts?.["particle.data"]?.sha256 !== hash(baselineBytes!) ||
    baselineReport.artifacts?.["particle.texture.png"]?.sha256 !== hash(baselinePng!))
)
  throw new Error("Baseline artifacts do not match their recorded paired hashes");
const lightProfile = NATIVE_EFFECT_PROFILES.find(
  (profile) => profile.quality === 2 && profile.noteEffectSkin === "effect001",
);
if (isDelta && !lightProfile) throw new Error("Missing authored Light profile");
const sourcePaths = [
  "packages/sonolus/scripts/native-particles/trace.ts",
  "packages/sonolus/scripts/native-particles/compile.ts",
  "packages/sonolus/scripts/native-particles/merge.ts",
  "packages/sonolus/scripts/native-particles/fit.ts",
  "packages/sonolus/scripts/native-particles/bake.ts",
  "packages/sonolus/scripts/native-particles/textureBake.ts",
  "packages/sonolus/scripts/build-native-particle-assets.ts",
  ".dependencies/cassiopeia-renderer-three/src/render/ParticleLayer.ts",
  ".dependencies/cassiopeia-plugin-our-notes/src/assets/manifest.ts",
  ".dependencies/sonolus-our-notes/contract/native-effects.json",
];
const sourceHashes = isDelta
  ? Object.fromEntries(sourcePaths.map((path) => [path, hash(readFileSync(resolve(root, path)))]))
  : undefined;
const compiled = await compileNativeParticles({
  releaseRoot: workspace.releaseRoot,
  ...(isDelta
    ? { profiles: [lightProfile!], only: (name: string) => name.startsWith(`${lightProfile!.prefix} `) }
    : {}),
  ...(only ? { only: (name: string) => name === only } : {}),
  log: console.log,
});
if (!compiled.effects.length) throw new Error(`No particle effect matched ${only}`);
if (sourceHashes)
  for (const [path, expected] of Object.entries(sourceHashes))
    if (hash(readFileSync(resolve(root, path))) !== expected)
      throw new Error(`Input changed during Light delta: ${path}`);
if (isDelta && compiled.effects.length !== 500)
  throw new Error("Light delta must fit exactly 500 named plane variants");
const merged = baseline ? mergeNativeParticleDelta(baseline, baselinePng!, compiled) : undefined;

const out = resolve(destination);
mkdirSync(out, { recursive: true });
const particle = merged?.data ?? {
  width: compiled.atlas.width,
  height: compiled.atlas.height,
  interpolation: true,
  sprites: compiled.atlas.sprites,
  effects: compiled.effects,
};
const dataBytes = gzipSync(JSON.stringify(particle), { level: 9 });
const pngBytes = merged?.png ?? compiled.atlas.png;
writeFileSync(resolve(out, "particle.data"), dataBytes);
writeFileSync(resolve(out, "particle.texture.png"), pngBytes);
const reports = new Map(compiled.report.map((entry) => [entry.name, entry]));
writeFileSync(
  resolve(out, "native-particle-report.json"),
  JSON.stringify(
    {
      schema: "our-notes-native-particles-v3",
      sourceId: provenance.sourceId,
      releaseId: provenance.releaseId,
      partial: Boolean(only),
      atlas: { width: particle.width, height: particle.height, sprites: particle.sprites.length },
      effects: baselineReport
        ? baselineReport.effects.map((entry: { name: string }) => reports.get(entry.name) ?? entry)
        : compiled.report,
      ...(merged
        ? {
            mode: "light-material-delta",
            baseline: {
              directory: resolve(baselineDirectory!),
              dataSha256: hash(baselineBytes!),
              textureSha256: hash(baselinePng!),
            },
            sourceHashes,
            delta: {
              fitted: merged.fitted,
              affected: merged.affected,
              unchanged: particle.effects.length - merged.affected.length,
              appendedSprites: merged.appendedSprites,
              reusedSprites: merged.reusedSprites,
              protectedSprites: merged.protectedSprites,
              reclaimedUnusedSprites: merged.reclaimedUnusedSprites,
            },
            artifacts: {
              "particle.data": { bytes: dataBytes.length, sha1: hash(dataBytes, "sha1"), sha256: hash(dataBytes) },
              "particle.texture.png": { bytes: pngBytes.length, sha1: hash(pngBytes, "sha1"), sha256: hash(pngBytes) },
            },
          }
        : {}),
    },
    null,
    2,
  ) + "\n",
);
console.log(`Built ${particle.effects.length} native particle effects (${compiled.effects.length} fitted) into ${out}`);
