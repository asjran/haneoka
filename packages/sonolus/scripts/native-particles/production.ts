import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import { readSimpleLoopWorldRom } from "./simpleLoopWorldRom.ts";
import { refreshNativeParticlePackReports } from "./packs.ts";
import { writeParticleSourceEmptyProof } from "./sourceEmptyProof.ts";
import { prepareParticleRuntime, sourceTree } from "./runtime.ts";
import { particleCacheKey, restoreParticleCache, saveParticleCache } from "./cache.ts";
import { SIMPLE_LOOP_WORLD_ROM as ABI } from "../../../../.dependencies/sonolus-our-notes/shared/src/engine/data/simpleLoopWorldRomAbi.ts";
import { buildNativeParticleLifetimeAssets } from "../../../../.dependencies/sonolus-our-notes/scripts/build-native-particle-lifetime-assets.ts";
import type { SonolusInputProvenance } from "../../src/server/sonolusProvenance.ts";

interface ProductionRecipe {
  schema: string;
  baseline: string;
  sourceId: string;
  sourceReleaseId: string;
  sourceSnapshot: { directory: string; files: Array<{ path: string; sha256: string }> };
  baselineFiles: Array<{ path: string; sha256: string }>;
  runtimeHashes: Record<string, string>;
  sourceInputs: Array<{ path: string; sha256: string; bytes: number }>;
  maximumAtlasHeights?: Partial<Record<"standard" | "light", number>>;
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const particleInput = (file: { path: string }) =>
  !file.path.startsWith("runtime/note-se/") && file.path !== "metadata/cri.json";

/** The Simple pack shares the engine's authored lifetime-alias compiler. */
export function buildProductionParticleLifetimes(directory: string) {
  const simple = resolve(directory, "particles/simple");
  return buildNativeParticleLifetimeAssets({ destination: simple, baseline: simple });
}

/** Content identity excludes the release label and unrelated host source. */
export function productionParticleInputs(root: string, provenance: SonolusInputProvenance) {
  const assetRoot = resolve(root, "packages/sonolus/assets/native-particles");
  const recipeFile = resolve(assetRoot, "production.v1.json");
  const recipe = JSON.parse(readFileSync(recipeFile, "utf8")) as ProductionRecipe;
  if (recipe.schema !== "our-notes-production-particles-v1" || recipe.baseline !== "v10")
    throw new Error("Unknown native-particle production recipe");
  const baseline = resolve(assetRoot, recipe.baseline);
  for (const file of recipe.baselineFiles)
    if (hash(readFileSync(resolve(baseline, file.path))) !== file.sha256)
      throw new Error(`Native-particle bake input changed: ${file.path}`);
  const requestInputs = provenance.files.filter(particleInput).sort((a, b) => a.path.localeCompare(b.path));
  const projectionMatches = isDeepStrictEqual(requestInputs, recipe.sourceInputs);
  if (!projectionMatches)
    throw new Error(
      "Native-particle formal inputs changed; run the current runtime projection before qualifying the bake recipe",
    );
  const actualInputs = requestInputs;
  const snapshot = resolve(assetRoot, recipe.sourceSnapshot.directory);
  for (const file of recipe.sourceSnapshot.files)
    if (hash(readFileSync(resolve(snapshot, file.path))) !== file.sha256)
      throw new Error(`Native-particle source snapshot changed: ${file.path}`);
  const initial = JSON.parse(readFileSync(resolve(snapshot, "provenance.json"), "utf8"));
  if (
    hash(gunzipSync(readFileSync(resolve(snapshot, "particle.data")))) !== initial.sourceDataSha256 ||
    hash(readFileSync(resolve(snapshot, "particle.texture.png"))) !== initial.sourceTextureSha256
  )
    throw new Error("Initial particle data/texture provenance changed");
  const runtime = prepareParticleRuntime(root, recipe.runtimeHashes);
  const sourceFiles = [
    "packages/sonolus/scripts/build-native-source-star-assets.ts",
    "packages/sonolus/scripts/build-native-source-point-assets.ts",
    "packages/sonolus/scripts/pack-original-note-skins.ts",
    "packages/sonolus/src/shared/particlePacks.ts",
    ".dependencies/sonolus-our-notes/scripts/build-native-particle-lifetime-assets.ts",
    ".dependencies/sonolus-our-notes/shared/src/engine/data/nativeEffects.ts",
    ".dependencies/sonolus-our-notes/shared/src/engine/data/lane.ts",
    ".dependencies/sonolus-our-notes/shared/src/engine/data/simpleLoopWorldRomAbi.ts",
    ".dependencies/sonolus-our-notes/shared/src/engine/data/sourceViewBillboard.ts",
  ].map((path) => ({ path, sha256: hash(readFileSync(resolve(root, path))) }));
  const threeEntry = fileURLToPath(import.meta.resolve("three"));
  const threeSources = [threeEntry, resolve(dirname(threeEntry), "three.core.js")].map((file) => ({
    path: file.slice(dirname(threeEntry).length + 1),
    sha256: hash(readFileSync(file)),
  }));
  const input = {
    schema: "our-notes-particle-cache-v1",
    recipeSha256: hash(readFileSync(recipeFile)),
    sourceInputs: actualInputs,
    compilerSource: sourceTree(resolve(root, "packages/sonolus/scripts/native-particles")),
    sourceFiles,
    runtimeSourceKey: runtime.sourceKey,
    runtimeOutput: runtime.output,
    threeSources,
    runtimeHashes: recipe.runtimeHashes,
    nodeZlibVersion: process.versions.zlib,
  };
  return {
    recipeFile,
    recipe,
    baseline,
    snapshot,
    actualInputs,
    requestInputs,
    projectionMatches,
    runtime,
    input,
    cacheKey: particleCacheKey(input),
  };
}

/** Rebuild the qualified deltas over their versioned bake input, including the Source-loop ROM. */
export async function buildProductionParticles(root: string, releaseRoot: string, provenance: SonolusInputProvenance) {
  const {
    recipeFile,
    recipe,
    baseline,
    snapshot,
    actualInputs,
    requestInputs,
    projectionMatches,
    runtime,
    input,
    cacheKey,
  } = productionParticleInputs(root, provenance);
  const modules = runtime.modules;
  const rom = readFileSync(resolve(baseline, "EngineRom")),
    source = readSimpleLoopWorldRom(rom);
  if (
    !source.phaseOffset ||
    source.phaseProgramCount !== ABI.phaseCount ||
    source.maximumLatePhase !== ABI.maximumLatePhase
  )
    throw new Error("Native-particle phase ROM does not match the engine ABI");
  for (let offset = 0; offset < rom.length; offset += 4)
    if (!Number.isFinite(rom.readFloatLE(offset))) throw new Error("Native-particle ROM contains a non-finite value");
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "haneoka-native-particles-"));
  const directory = resolve(temporaryDirectory, "final");
  if (restoreParticleCache(root, cacheKey, directory)) {
    const report = JSON.parse(readFileSync(resolve(directory, "native-particle-report.json"), "utf8"));
    return {
      directory,
      temporaryDirectory,
      report,
      cacheKey,
      reused: true,
      requestInputCount: requestInputs.length,
      projectionMatches,
    };
  }
  const hook = runtime.register();
  try {
    const runtimeFiles = {
      renderer: modules.renderer!,
      authored: modules.authored!,
      contract: modules.contract!,
    };
    const { buildSourceCenterDelta } = await import("./sourceCenters.ts");
    const { buildSourceRigDelta } = await import("./sourceRigs.ts");
    const { buildSourceStarAssets } = await import("../build-native-source-star-assets.ts");
    const { buildSourcePointAssets } = await import("../build-native-source-point-assets.ts");
    const profiles = resolve(root, "packages/sonolus/scripts/native-particles/profiles");
    const centers = resolve(temporaryDirectory, "centers"),
      rigs = resolve(temporaryDirectory, "rigs"),
      standardStars = resolve(temporaryDirectory, "standard-stars"),
      lightStars = resolve(temporaryDirectory, "light-stars"),
      standardPoints = resolve(temporaryDirectory, "standard-points");
    await buildSourceCenterDelta({
      destination: centers,
      baseline,
      releaseRoot,
      runtimeFiles,
      recipePath: resolve(profiles, "center-billboards.v1.json"),
    });
    await buildSourceRigDelta({
      destination: rigs,
      baseline: centers,
      releaseRoot,
      runtimeFiles,
      recipePath: resolve(profiles, "rig-fields.v1.json"),
    });
    await buildSourceStarAssets({
      destination: standardStars,
      baseline: rigs,
      releaseRoot,
      runtimeFiles: modules,
      profilePath: resolve(profiles, "standard-source-stars.v1.json"),
      profile: "standard",
    });
    await buildSourceStarAssets({
      destination: lightStars,
      baseline: standardStars,
      releaseRoot,
      runtimeFiles: modules,
      profilePath: resolve(profiles, "light-source-stars.v1.json"),
      profile: "light",
    });
    await buildSourcePointAssets({
      destination: standardPoints,
      baseline: lightStars,
      releaseRoot,
      profile: "standard",
      target: "all",
      maximumAtlasHeight: recipe.maximumAtlasHeights?.standard ?? 1024,
    });
    await buildSourcePointAssets({
      destination: directory,
      baseline: standardPoints,
      releaseRoot,
      profile: "light",
      target: "all",
      maximumAtlasHeight: recipe.maximumAtlasHeights?.light ?? 1024,
    });
    const { buildSourceStarSceneMaterialAssets } = await import("./sourceStarSceneMaterial.ts");
    buildSourceStarSceneMaterialAssets(
      directory,
      resolve(profiles, "source-star-scene-response.v1.json"),
      recipe.maximumAtlasHeights,
    );
    const { buildFloorBeamMaterialAssets } = await import("./floorBeamMaterial.ts");
    buildFloorBeamMaterialAssets(directory);
    buildProductionParticleLifetimes(directory);
    refreshNativeParticlePackReports(directory);
    const manifestFile = resolve(directory, "particle-packs.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    const initial = JSON.parse(readFileSync(resolve(snapshot, "provenance.json"), "utf8"));
    for (const key of ["sourceDataSha256", "sourceTextureSha256", "sourceHashes"]) {
      if (manifest[key] !== undefined && JSON.stringify(manifest[key]) !== JSON.stringify(initial[key]))
        throw new Error(`Initial particle provenance changed: ${key}`);
      manifest[key] = initial[key];
    }
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
    writeParticleSourceEmptyProof(directory, resolve(snapshot, "particle.data"));
    const stageProofs = [
      [centers, "source-centers-proof.json", "source-centers-proof.json"],
      [rigs, "source-rigs-proof.json", "source-rigs-proof.json"],
      [standardStars, "standard-complete-source-births.json", "standard-complete-source-births.json"],
      [standardStars, "standard-hdr-material-proof.json", "standard-hdr-material-proof.json"],
      [standardStars, "star-delta-report.json", "source-stars-standard-delta.json"],
      [standardStars, "linearization-proof.json", "source-stars-standard-linearization.json"],
      [lightStars, "light-complete-source-births.json", "light-complete-source-births.json"],
      [lightStars, "light-hdr-material-proof.json", "light-hdr-material-proof.json"],
      [lightStars, "star-delta-report.json", "source-stars-light-delta.json"],
      [lightStars, "linearization-proof.json", "source-stars-light-linearization.json"],
      [standardPoints, "source-points-proof.json", "source-points-standard-proof.json"],
      [directory, "source-points-proof.json", "source-points-light-proof.json"],
      [directory, "source-star-scene-material-proof.json", "source-stars-scene-proof.json"],
      [directory, "floor-beam-material-proof.json", "floor-beam-material-response-proof.json"],
      [resolve(directory, "particles/simple"), "particle-lifetime-report.json", "simple-flick-lifetime-proof.json"],
    ] as const;
    const proofs = stageProofs.map(([stage, sourceFile, file]) => {
      copyFileSync(resolve(stage, sourceFile), resolve(directory, file));
      return { file, sha256: hash(readFileSync(resolve(directory, file))) };
    });
    writeFileSync(resolve(directory, "EngineRom"), rom);
    // Legacy thumbnail consumers use the default Standard item, not a second particle implementation.
    for (const file of ["particle.data", "particle.texture.png"])
      copyFileSync(resolve(directory, "particles/standard", file), resolve(directory, file));
    const report = {
      schema: "our-notes-production-particles-v1",
      recipeSha256: hash(readFileSync(recipeFile)),
      sourceId: recipe.sourceId,
      releaseId: recipe.sourceReleaseId,
      cacheKey,
      sourceInputs: actualInputs.length,
      runtimeHashes: recipe.runtimeHashes,
      baselineFiles: recipe.baselineFiles,
      phaseRomSha256: hash(rom),
      phases: ABI.phaseCount,
      source: ["effect001", "effect001Light", "effect001Simple"],
      pipeline: [
        "centers",
        "rigs",
        "standard-stars",
        "light-stars",
        "standard-points",
        "light-points",
        "source-star-scene-response",
        "floor-beam-material",
        "simple-flick-lifetimes",
      ],
      proofs,
    };
    for (const [name, file] of Object.entries(modules))
      if (hash(readFileSync(file)) !== recipe.runtimeHashes[name])
        throw new Error(`Native-particle runtime changed during generation: ${name}`);
    writeFileSync(resolve(directory, "native-particle-report.json"), JSON.stringify(report, null, 2) + "\n");
    saveParticleCache(root, cacheKey, directory, input);
    return {
      directory,
      temporaryDirectory,
      report,
      cacheKey,
      reused: false,
      requestInputCount: requestInputs.length,
      projectionMatches,
    };
  } catch (error) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    hook.deregister();
  }
}
