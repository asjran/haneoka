#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import type { ParticleData } from "./native-particles/merge.ts";
import { NATIVE_EFFECT_WIDTHS } from "../../../.dependencies/sonolus-our-notes/shared/src/engine/data/nativeEffects.ts";

import type { HdrCarrierPair, Tile, TileRequest } from "./native-particles/bake.ts";
import type { TrajectoryParticle } from "./native-particles/trajectory.ts";

type ParticleGroup = { count: number; particles: TrajectoryParticle[] };
type JsonRecord = Record<string, unknown>;
interface SourceMotionRow {
  effect: string;
  width: number;
  plane: number;
  system: number;
  sourceMembers: Array<{ seed: number; emission: number; birth: number; lifetime: number }>;
  tileGeometry: { expand: readonly [number, number]; offset: readonly [number, number] };
}
interface SourceColorKey { time: number; color: { r: number; g: number; b: number; a: number } }
interface SourceFootprint { height1080: number; area: number; emission: number }
interface SourceAlphaModel {
  birth: number;
  lifetime: number;
  peak: number[];
  amplitude: (time: number) => number;
  colorKeys: SourceColorKey[];
  alphaKeys: number[];
  footprints: SourceFootprint[];
  file: string;
}
interface StarReport {
  key: string; kind: StarKind; width: number; selectedGroups: number[];
  actors: number; groups: number; definitions: number;
}

type StarKind = "Normal" | "Flick";
interface StarMaterialRecipe {
  nativePeak: { whitenCore: boolean; sourceTint: boolean; exposureLevels?: number[] };
  coreBloomMips?: number;
  centralPatch?: { system: number; referenceWidth: number; density: number };
  halo?: { mipTo: number; maximumAlpha: number; maximumAreaRatio: number };
}
interface StarSourceProfile {
  completeSourceBirths: true;
  sourceSeed?: number;
  hdrCarriers: { sourceFrameRate: number; maxPixelError960: number; maxAlphaError: number; renderingScale: number; referenceViewportHeight: number; sourceFootprintKernels: true; sources: Record<string, Array<{ group: number; system: number; emission: number; crop: [number, number, number, number]; motionSha256: string }>> };
  schema: string;
  profile: string;
  sourceRendererSha256: string;
  sourceAuthoredSha256: string;
  limits: { selectedDefinitions: number; atlasSide: number; perEffectDefinitions: Record<string, number>; targetPerEffectDefinitions?: Record<string, number> };
  materials?: Partial<Record<StarKind, StarMaterialRecipe>>;
}

export interface SourceStarAssetsOptions {
  destination: string;
  baseline: string;
  releaseRoot: string;
  profilePath: string;
  profile: "standard" | "light";
  runtimeFiles?: Partial<Record<"core" | "renderer" | "profile" | "authored" | "contract", string>>;
  producerRoot?: string;
  widths?: readonly number[];
}

export async function buildSourceStarAssets(options: SourceStarAssetsOptions) {
  const { destination: output, baseline, releaseRoot, profilePath, profile: onlyProfile, producerRoot } = options;
  if (resolve(output) === resolve(baseline)) throw new Error("Star delta requires a separate output");
  const outputDirectory = resolve(output), baselineDirectory = resolve(baseline);
  const aliases = {
    core: "@haneoka/cassiopeia",
    renderer: "@haneoka/cassiopeia-renderer-three",
    profile: "@haneoka/cassiopeia-plugin-our-notes",
    authored: "@haneoka/cassiopeia-plugin-our-notes/authored",
    contract: "@haneoka/sonolus-our-notes/contract/native-effects.json",
  } as const;
  const offline = producerRoot ? {
    core: resolve(producerRoot, "core/index.js"),
    renderer: resolve(producerRoot, "renderer/index.js"),
    profile: resolve(producerRoot, "profile/index.js"),
    authored: resolve(producerRoot, "profile/authored.js"),
    contract: resolve(producerRoot, ".dependencies/sonolus-our-notes/contract/native-effects.json"),
  } : undefined;
  const actualProducers = Object.fromEntries(Object.values(aliases).map((alias) => [alias, fileURLToPath(import.meta.resolve(alias))]));
  const producers: Record<string, string> = Object.fromEntries(Object.entries(aliases).map(([key, alias]) => [
    alias, options.runtimeFiles?.[key as keyof typeof aliases] ?? offline?.[key as keyof typeof aliases] ?? actualProducers[alias]!,
  ]));
  const widths = options.widths ?? NATIVE_EFFECT_WIDTHS;
  if (widths.some((width) => !NATIVE_EFFECT_WIDTHS.includes(width as never))) throw new Error("Unsupported star width");
  const hook = producerRoot ? registerHooks({
    resolve(specifier, context, next) {
      return producers[specifier] ? { url: pathToFileURL(producers[specifier]).href, shortCircuit: true } : next(specifier, context);
    },
  }) : undefined;
  const previousFitReport = process.env.SONOLUS_FIT_REPORT;
  process.env.SONOLUS_FIT_REPORT = "1";
  try {
    const { compileNativeParticles, motionFitReport } = await import("./native-particles/compile.ts");
    const { mergeParticleGroupDelta } = await import("./native-particles/groupDelta.ts");
    const { repackParticleAtlas } = await import("./native-particles/repack.ts");
    const sourceProfile = JSON.parse(readFileSync(profilePath, "utf8")) as StarSourceProfile;
    if (
      sourceProfile.schema !== `our-notes-${onlyProfile}-star-source-v1` ||
      sourceProfile.profile !== onlyProfile ||
      !onlyProfile || !sourceProfile.hdrCarriers || sourceProfile.completeSourceBirths !== true ||
      sourceProfile.hdrCarriers.sourceFootprintKernels !== true
    )
      throw new Error("This Source star profile requires an explicit matching target");
    const sha = (b: Uint8Array, algorithm = "sha1") => createHash(algorithm).update(b).digest("hex");
    if (!producerRoot) for (const [alias, file] of Object.entries(producers))
      if (sha(readFileSync(file), "sha256") !== sha(readFileSync(actualProducers[alias]!), "sha256"))
        throw new Error(`Source runtime override differs from the public module: ${alias}`);
    if (
      sha(readFileSync(producers["@haneoka/cassiopeia-renderer-three"]!), "sha256") !==
        sourceProfile.sourceRendererSha256 ||
      sha(readFileSync(producers["@haneoka/cassiopeia-plugin-our-notes/authored"]!), "sha256") !==
        sourceProfile.sourceAuthoredSha256
    )
      throw new Error("Source runtime does not match the frozen star profile");
    if (
      !Number.isSafeInteger(sourceProfile.limits?.selectedDefinitions) ||
      sourceProfile.limits.selectedDefinitions <= 0 ||
      sourceProfile.limits?.atlasSide !== 1024
    )
      throw new Error("Invalid admitted Source star budget");

    const paths = [
      "build-native-source-star-assets.ts",
      "pack-original-note-skins.ts",
      ...[
        "compile",
        "trace",
        "fit",
        "bake",
        "budget",
        "billboard",
        "trajectory",
        "groupDelta",
        "merge",
        "repack",
        "textureBake",
        "rectanglePacking",
        "sourceCentralPatch",
        "sourceStarHalo",
      ].map((n) => `native-particles/${n}.ts`),
    ].map((p) => resolve(import.meta.dirname, p));
    paths.push(resolve(profilePath));
    paths.push(
      resolve(import.meta.dirname, "../../../.dependencies/sonolus-our-notes/shared/src/engine/data/nativeEffects.ts"),
    );
    const sourceHashes = Object.fromEntries(
      [...paths, ...Object.values(producers)].map((p) => [p, sha(readFileSync(p), "sha256")]),
    );
    mkdirSync(output, { recursive: true });
    const report: StarReport[] = [];
    const manifest = JSON.parse(readFileSync(resolve(baseline, "particle-packs.json"), "utf8"));
    function writePack(key: string, data: ParticleData, png: Buffer): void {
      const path = resolve(outputDirectory, "particles", key);
      mkdirSync(path, { recursive: true });
      const zipped = gzipSync(JSON.stringify(data), { level: 9 });
      writeFileSync(resolve(path, "particle.data"), zipped);
      writeFileSync(resolve(path, "particle.texture.png"), png);
      const pack = JSON.parse(readFileSync(resolve(baselineDirectory, "particles", key, "particle-pack-report.json"), "utf8"));
      pack.effects = data.effects.length;
      pack.groups = data.effects.reduce((n, e) => n + (e.groups as ParticleGroup[]).length, 0);
      pack.instances = data.effects.reduce((n, e) => n + (e.groups as ParticleGroup[]).reduce((s, g) => s + g.count, 0), 0);
      pack.definitions = data.effects.reduce(
        (n, e) => n + (e.groups as ParticleGroup[]).reduce((s, g) => s + g.count * g.particles.length, 0),
        0,
      );
      pack.atlas = { width: data.width, height: data.height, sprites: data.sprites.length };
      pack.artifacts = {
        data: { bytes: zipped.length, sha1: sha(zipped) },
        texture: { bytes: png.length, sha1: sha(png) },
      };
      if (key === sourceProfile.profile) pack.sourceHdrMaterial = { strategy: "source-peak-basis-with-fixed-material-stages",
        proof: `${key}-hdr-material-proof.json`, sha256: sha(readFileSync(resolve(output!, `${key}-hdr-material-proof.json`)), "sha256") };
      writeFileSync(resolve(path, "particle-pack-report.json"), JSON.stringify(pack, null, 2));
      manifest.packs = manifest.packs.map((p: { key: string }) => (p.key === key ? pack : p));
    }


    /** Material-only pass over the admitted motion records. */
    async function buildHdrMaterialPack(key: "standard" | "light", quality: number) {
      let policy = sourceProfile.hdrCarriers;
      const { EffectTracer, W_TO_H } = await import("./native-particles/trace.ts");
      const { bakeHdrCarrierPair, bakeCarrierBasisSet, packAtlas } = await import("./native-particles/bake.ts");
      const { fitSourceAlphaTrajectory, durationBeforeNextPhase, fitBudgetedSourceMaterial, allocateSourceMaterialBudget, auditSourceMaterialTrajectory } = await import("./native-particles/trajectory.ts");
      const { evaluateNativeMinMaxGradient } = await import("@haneoka/cassiopeia-plugin-our-notes/authored");
      const { decodeRgba8Png } = await import("./pack-original-note-skins.ts");
      const { nativeEffectPlaneQuad } = await import("../../../.dependencies/sonolus-our-notes/shared/src/engine/data/nativeEffects.ts");
      const { horizonY, judgmentY, getNativeLaneUnitWidth } = await import("../../../.dependencies/sonolus-our-notes/shared/src/engine/data/lane.ts");
      const dataFile = resolve(baseline!, "particles", key, "particle.data");
      let data = JSON.parse(gunzipSync(readFileSync(dataFile)).toString()) as ParticleData;
      let png: Buffer = readFileSync(resolve(baseline!, "particles", key, "particle.texture.png"));
      const tracer = new EffectTracer({ releaseRoot: releaseRoot!, currentQuality: quality, noteEffectSkin: "effect001" });
      await tracer.load();
      const completeRepresentatives = new Map<StarKind, Array<{ system: number; emission: number; seed: number }>>();
      {
        const prefix = key === "light" ? "Our Notes Light" : "Our Notes Native";
        const representatives = new Map<string, Array<{ system: number; emission: number; seed: number }>>();
        for (const kind of ["Normal", "Flick"] as const) {
          const seed = sourceProfile.sourceSeed ?? 4660;
          const trace = tracer.trace(
            { kind: kind === "Normal" ? "tap" : "flick", direction: "none", judgement: "perfect", lifetime: 5 / 12 },
            6, Array.from({ length: 26 }, (_, i) => i / policy.sourceFrameRate), [seed],
            { meshes: false, particle: ({ system }) => system === 1 || (kind === "Flick" && system === 4) },
          );
          const births = [...new Map(trace.particles.map((p) => [`${p.system}:${p.emission_}`, {
            system: p.system, emission: p.emission_, seed,
          }])).values()];
          completeRepresentatives.set(kind, births);
          for (const width of widths) representatives.set(`${prefix} ${kind} W${width}`, births);
        }
        motionFitReport.length = 0;
        const motion = await compileNativeParticles({
          releaseRoot: releaseRoot!, profiles: [{ prefix, quality, noteEffectSkin: "effect001" }], billboardsOnly: true,
          particleFamilies: ["star"], billboardSystemTiles: true, particleMotion: "source-trajectories",
          particleRepresentatives: representatives, preserveSourceParticleCount: true, particleSampleRate: policy.sourceFrameRate,
          particleColourKeys: false, particleAlpha: "constant", particleRequireBrackets: true,
          particlePieces: 6, particleCompression: false,
          only: (name) => ["Normal", "Flick"].some((kind) => widths.some((width) => name === `${prefix} ${kind} W${width}`)),
          log: console.log,
        });
        const rows = structuredClone(motionFitReport) as unknown as SourceMotionRow[];
        const sources = structuredClone(policy.sources);
        const birthsProof: JsonRecord[] = [];
        for (const kind of ["Normal", "Flick"] as const) for (const width of widths) {
          const name = `Our Notes Native ${kind} W${width} P0`;
          const effect = data.effects.find((e) => e.name === name)!;
          const old = new Set(policy.sources[name]!.map((r) => r.group));
          const retained = (effect.groups as ParticleGroup[]).filter((_, index) => !old.has(index));
          const replacement = motion.effects.find((e) => e.name === `${prefix} ${kind} W${width} P0`)!;
          const replacementGroups = replacement.groups as ParticleGroup[];
          const selected = rows.filter((r) => r.effect === `${prefix} ${kind}` && r.width === width && r.plane === 0);
          if (selected.length !== replacementGroups.length || selected.length !== completeRepresentatives.get(kind)!.length)
            throw new Error("Formal star birth count differs from the source motion program");
          const existingSprite = (effect.groups as ParticleGroup[])[policy.sources[name]![0]!.group]!.particles[0]!.sprite;
          sources[name] = selected.map((row, index) => {
            const group = structuredClone(replacementGroups[index]!);
            if (group.count !== 1 || row.sourceMembers.length !== 1) throw new Error("Source stars require fixed birth identities");
            for (const p of group.particles) p.sprite = existingSprite;
            const member = row.sourceMembers[0]!;
            const image = decodeRgba8Png(readFileSync(tracer.textureFile(row.system === 4 ? "longStar" : "star")), "formal star");
            const w = Math.round(image.width * row.tileGeometry.expand[0]), h = Math.round(image.height * row.tileGeometry.expand[1]);
            const crop: [number, number, number, number] = [
              Math.round(image.width * (.5 + row.tileGeometry.offset[0]) - w / 2),
              Math.round(image.height * (.5 - row.tileGeometry.offset[1]) - h / 2), w, h,
            ];
            const motionProgram = { count: group.count, particles: group.particles.map((p) =>
              Object.fromEntries((["start", "duration", "x", "y", "w", "h", "r"] as const).map((c) => [c, p[c]]))) };
            const groupIndex = retained.length;
            retained.push(group);
            birthsProof.push({ effect: name, group: groupIndex, system: row.system, emission: member.emission,
              seed: member.seed, birth: member.birth, lifetime: member.lifetime, crop, motionPieces: group.particles.length });
            return { group: groupIndex, system: row.system, emission: member.emission, crop,
              motionSha256: sha(Buffer.from(JSON.stringify(motionProgram)), "sha256") };
          });
          effect.groups = retained;
        }
        policy = { ...policy, sources };
        writeFileSync(resolve(output!, `${key}-complete-source-births.json`), JSON.stringify({ births: birthsProof,
          sourceBudgets: motion.sourceBudgets, sourceSeed: sourceProfile.sourceSeed ?? 4660 }, null, 2));
      }
      const base = structuredClone(data);
      const alphaSampler = new Map<string, SourceAlphaModel>();
      const clockReport: JsonRecord[] = [];
      const layers: Array<JsonRecord & { effect: string; group: number; emission: number; definitions: number }> = [];
      const centralPatches: JsonRecord[] = [];
      const haloPatches: JsonRecord[] = [];
      const peakCache = new Map<string, HdrCarrierPair>();
      const basisCache = new Map<string, ReturnType<typeof bakeCarrierBasisSet>>();
      const budgetProofs: JsonRecord[] = [];
      const duration = Math.fround(5 / 12);
      for (const kind of ["Normal", "Flick"] as const) {
        const centralPolicy = sourceProfile.materials?.[kind]?.centralPatch;
        const representatives = completeRepresentatives.get(kind)!;
        const sampleWidths = [...new Set([...widths, ...(centralPolicy ? [centralPolicy.referenceWidth] : [])])];
        const sampled = { particles: sampleWidths.flatMap((width) => tracer.trace(
          { kind: kind === "Normal" ? "tap" : "flick", direction: "none", judgement: "perfect", lifetime: 5 / 12 },
          width, Array.from({ length: 26 }, (_, i) => i / policy.sourceFrameRate), [sourceProfile.sourceSeed ?? 4660],
          { meshes: false, particle: (x) => representatives.some((r) => r.system === x.system && r.emission === x.emission) },
        ).particles) };
        const { buildSourceCentralPatch, shareSourceCentralPatch } = await import("./native-particles/sourceCentralPatch.ts");
        const centralSamples = centralPolicy ? sampled.particles.filter((p) => p.system === centralPolicy.system && p.sourceLayout?.width === centralPolicy.referenceWidth) : [];
        const centralMaster = centralPolicy ? buildSourceCentralPatch(centralSamples, centralPolicy.referenceWidth, {
          lifetime: 5 / 12, sourceScale: policy.renderingScale, density: centralPolicy.density,
          coreBloomMips: sourceProfile.materials?.[kind]?.coreBloomMips ?? 0,
        }) : undefined;
        for (const identity of representatives) {
          const samples = sampled.particles.filter((p) => p.system === identity.system && p.emission_ === identity.emission);
          const entry = samples.filter((p) => p.sourceClock).at(-1)!;
          if (!entry?.sourceClock) throw new Error("Missing formal source material clock");
          const clock = entry.sourceClock;
          const birth = entry.t - clock.simulationAge / clock.serializedSimulationSpeed;
          const lifetime = clock.simulationLifetime / clock.serializedSimulationSpeed;
          const definition = tracer.assets.particles.effect001Prefabs[kind]!.particleSystems[identity.system]!;
          const metadata = readFileSync(definition.metadataUrl);
          const formal = JSON.parse(metadata.toString()).data;
          const gradient = formal.ColorModule.gradient.maxGradient;
          const colorKeys = Array.from({ length: gradient.m_NumColorKeys }, (_, i) => ({
            time: birth + (gradient[`ctime${i}`] / 65535) * lifetime, color: gradient[`key${i}`],
          }));
          if (colorKeys.some((k) => k.color.r !== k.color.g || k.color.g !== k.color.b))
            throw new Error("A changing source hue requires more than one scalar HDR envelope");
          const alphaKeys = Array.from({ length: gradient.m_NumAlphaKeys }, (_, i) =>
            birth + (gradient[`atime${i}`] / 65535) * lifetime);
          const peak = samples.reduce((a, p) => a.map((value, i) => Math.max(value, p.emission[i]!)), [0, 0, 0]);
          const amplitude = (time: number) => {
            const color = evaluateNativeMinMaxGradient(formal.ColorModule.gradient, (time * duration - birth) / lifetime);
            return Math.max(0, Math.min(1, color.b * color.a));
          };
          const footprints = samples.filter((s) => s.pixelHeight > 0).map((s) => ({ height1080: s.pixelHeight, area: s.pixelArea, emission: Math.max(...s.emission) / Math.max(...peak) }));
          const model = { birth, lifetime, peak, amplitude, colorKeys, alphaKeys, footprints,
            file: tracer.textureFile(identity.system === 4 ? "longStar" : "star") };
          alphaSampler.set(`${kind}:${identity.system}:${identity.emission}`, model);
          clockReport.push({ kind, ...identity, birth, lifetime, peak, source: definition.metadataUrl,
            sourceSha256: sha(metadata, "sha256"), sourceClock: clock });
        }
        const kernelFor = (system: number, minimum: number, maximum: number) => {
          const all = representatives.filter((r) => r.system === system).flatMap((r) => alphaSampler.get(`${kind}:${r.system}:${r.emission}`)!.footprints) as Array<{ height1080: number; area: number; emission: number }>;
          const selected = all.filter((s) => s.emission > minimum && s.emission <= maximum + 1e-6);
          const samples = selected.length ? selected : all.filter((s) => s.emission > .1);
          const weight = (s: typeof samples[number]) => s.emission ** 2 * s.area;
          const sum = samples.reduce((n, s) => n + weight(s), 0);
          const height1080 = samples.reduce((n, s) => n + weight(s) * s.height1080 ** 2, 0)
            / samples.reduce((n, s) => n + weight(s) * s.height1080, 0);
          if (!(height1080 > 0) || !(policy.referenceViewportHeight! > 0)) throw new Error("Invalid Source footprint kernel");
          return { weighting: "hdr-amplitude-squared-times-projected-pixel-area", height1080, viewportHeight: policy.referenceViewportHeight, samples: selected.length, fallback: !selected.length,
            minimum: Math.min(...samples.map((s) => s.height1080)), maximum: Math.max(...samples.map((s) => s.height1080)),
            relativeSigmaRms: Math.sqrt(samples.reduce((n, s) => n + weight(s) * (s.height1080 / height1080 - 1) ** 2, 0) / sum) };
        };
        for (const width of widths) {
          const name = `Our Notes Native ${kind} W${width} P0`;
          const previous = base.effects.find((e) => e.name === name)!;
          const identities = policy.sources[name]!.slice().sort((a, b) => a.group - b.group);
          const tiles: Tile[] = [], groups: ParticleGroup[] = [];
          const materialFits: Array<{ fit: ReturnType<typeof fitBudgetedSourceMaterial>; row: JsonRecord & { group: number; emission: number; effect: string } }> = [];
          const tileIndices = new Map<string, number>();
          const registerTile = (tile: Tile) => {
            const hash = sha(tile.image.pixels, "sha256") + ":" + tile.image.width + ":" + tile.image.height;
            if (tileIndices.has(hash)) return tileIndices.get(hash)!;
            const index = tiles.length; tileIndices.set(hash, index); tiles.push(tile); return index;
          };
          const projects = [-6, 0, 6].flatMap((lane) => [0.1, 1, 2].map((size) => {
            const q = nativeEffectPlaneQuad(0, lane, width / 4, size, W_TO_H);
            return (x: number, y: number): readonly [number, number] => {
              const u = (x + 1) / 2, v = (y + 1) / 2;
              const bottom = q.x1 + (q.x4 - q.x1) * u, top = q.x2 + (q.x3 - q.x2) * u;
              const sx = bottom + (top - bottom) * v, sy = q.y1 + (q.y2 - q.y1) * v;
              return [480 + sx * getNativeLaneUnitWidth(960), 270 * (1 - (sy * (judgmentY - horizonY) + horizonY))];
            };
          }));
          for (const identity of identities) {
            const group = (previous.groups as ParticleGroup[])[identity.group]!;
            if (!group || group.count !== 1) throw new Error("Fixed source star identity changed");
            const motion = { count: group.count, particles: group.particles.map((p) => Object.fromEntries((["start", "duration", "x", "y", "w", "h", "r"] as const).map((c) => [c, p[c]]))) };
            if (sha(Buffer.from(JSON.stringify(motion)), "sha256") !== identity.motionSha256)
              throw new Error("Admitted source star motion changed");
            if (centralPolicy?.system === identity.system) continue;
            const model = alphaSampler.get(`${kind}:${identity.system}:${identity.emission}`)!;
            if (!model) throw new Error("Unknown source star identity");
            const image = decodeRgba8Png(readFileSync(model.file), model.file);
            const [x, y, w, h] = identity.crop;
            const kernel = kernelFor(identity.system, 0, 1);
            const sourceSigmaScale = (k: { height1080: number; viewportHeight: number }) => image.height / (2 * k.height1080 * (k.viewportHeight / 1080) * policy.renderingScale);
            const request: TileRequest = {
              key: `${key}|${kind}|${identity.system}|${identity.emission}`, file: model.file,
              uv: [x / image.width, 1 - (y + h) / image.height, (x + w) / image.width, 1 - y / image.height],
              emission: model.peak as [number, number, number], screenHeight: h / 2, screenAspect: w / h,
              mips: 1, sigmaScale: sourceSigmaScale(kernel),
              bloomGain: 1, padSides: [false, false, false, false] as [boolean, boolean, boolean, boolean], whitenCore: false,
              ...(sourceProfile.materials?.[kind]?.coreBloomMips !== undefined ? { coreBloomMips: sourceProfile.materials[kind]!.coreBloomMips! } : {}),
            };
            const recipe = sourceProfile.materials?.[kind]?.nativePeak;
            if (!recipe || typeof recipe.whitenCore !== "boolean" || typeof recipe.sourceTint !== "boolean")
              throw new Error("Missing explicit native Source peak material recipe");
            const materialKey = JSON.stringify([kind, identity.system, identity.crop, model.peak, request.sigmaScale, recipe.whitenCore]);
            let pair = peakCache.get(materialKey);
            if (!pair) {
              pair = bakeHdrCarrierPair({ ...request, whitenCore: recipe.whitenCore });
              peakCache.set(materialKey, pair);
            }
            const start = group.particles[0]!.start, end = group.particles.at(-1)!.start + group.particles.at(-1)!.duration;
            const keys = [start, end, ...model.colorKeys.map((k) => k.time / duration), ...model.alphaKeys.map((t: number) => t / duration)]
              .filter((t) => t >= start && t <= end).sort((a, b) => a - b);
            const crossings: number[] = [];
            for (let i = 1; i < keys.length; i++) {
              let left = keys[i - 1]!, right = keys[i]!;
              const before = model.amplitude(left) - pair.critical, after = model.amplitude(right) - pair.critical;
              if (before * after >= 0) continue;
              for (let j = 0; j < 50; j++) {
                const middle = (left + right) / 2;
                if ((model.amplitude(middle) > pair.critical) === (before > 0)) left = middle; else right = middle;
              }
              crossings.push((left + right) / 2);
            }
            // LDR has no bloom accumulation: retain the Source peak and fit
            // opacity to its first actual HDR channel clip, preserving zeroes.
            const alpha = (time: number) => Math.min(1, Math.max(0, model.amplitude(time)) / pair.critical);
            const zeroKnots = model.colorKeys.filter((k) => k.color.b === 0).map((k) => k.time / duration);
            if (recipe.exposureLevels) {
              let basis = basisCache.get(materialKey);
              if (!basis) {
                basis = bakeCarrierBasisSet(request, recipe.exposureLevels);
                basisCache.set(materialKey, basis);
              }
              const dominant = model.peak.indexOf(Math.max(...model.peak)) as 0 | 1 | 2;
              const secondary = [0, 1, 2].sort((a, b) => model.peak[b]! - model.peak[a]!)[1]!;
              const clipped = basis.moments[0]!.findIndex((sample) => sample.peak[secondary]! >= 254 / 255);
              const secondaryClip = clipped < 0 ? Infinity : clipped / basis.steps;
              const materialKnots: number[] = [], exposureKnots: number[] = [];
              for (let i = 1; i < keys.length; i++) for (const gain of [...basis.exposures, ...[0, 1, 2].map((c) => {
                const i = basis!.moments[0]!.findIndex((sample) => sample.peak[c]! >= 254 / 255);
                return i < 0 ? Infinity : i / basis!.steps;
              })]) {
                if (!Number.isFinite(gain)) continue;
                let left = keys[i - 1]!, right = keys[i]!; const first = model.amplitude(left) - gain;
                if (first * (model.amplitude(right) - gain) >= 0) continue;
                for (let step = 0; step < 40; step++) {
                  const middle = (left + right) / 2;
                  if ((model.amplitude(middle) > gain) === (first > 0)) left = middle; else right = middle;
                }
                const crossing = (left + right) / 2;
                exposureKnots.push(crossing);
                if (gain === secondaryClip) materialKnots.push(crossing);
              }
              const budget = sourceProfile.limits.perEffectDefinitions[`${kind}W${width}`]! -
                (centralMaster?.group.particles.length ?? 0);
              const fit = fitBudgetedSourceMaterial(group.particles, {
                bases: basis.moments.map((table, index) => ({
                  sprite: registerTile(basis!.tiles[index]!), peak: basis!.peaks[index]!,
                  covers: (time) => model.amplitude(time) < secondaryClip || model.amplitude(time) <= basis!.exposures[index]! + 1e-7,
                  momentsAt: (time) => {
                    const coordinate = model.amplitude(time) * basis!.steps,
                      i = Math.min(basis!.steps - 1, Math.floor(coordinate)), f = coordinate - i,
                      a = table[i]!, b = table[i + 1]!;
                    return { target: a.target * (1 - f) + b.target * f,
                      peak: a.peak.map((v, c) => v * (1 - f) + b.peak[c]! * f) as [number, number, number],
                      square: a.square.map((v, c) => v * (1 - f) + b.square[c]! * f) as [number, number, number],
                      dot: a.dot.map((v, c) => v * (1 - f) + b.dot[c]! * f) as [number, number, number] };
                  },
                })),
                knots: [...keys, ...exposureKnots, ...Array.from({ length: 26 }, (_, i) => i / policy.sourceFrameRate / duration)],
                zeroKnots: [...zeroKnots, ...materialKnots], projects, maxPixelError: policy.maxPixelError960,
                maxParticles: budget, alphaChannel: dominant,
              });
              const row = { effect: name, ...identity, strategy: "source-exposure-bases", exposureLevels: basis.exposures,
                alphaChannel: dominant, secondaryClip, sourceTint: recipe.sourceTint,
                stagePareto: fit.pareto.map(({ particles: _particles, ...entry }) => entry) };
              materialFits.push({ fit, row });
              continue;
            }
            const fitted = fitSourceAlphaTrajectory(group.particles, {
              minimumKnotSeparation: 1e-9, alpha, knots: [...keys, ...crossings], zeroKnots, projects,
              sprite: registerTile(pair.peak), maxPixelError: policy.maxPixelError960, maxAlphaError: policy.maxAlphaError,
            });
            for (let i = 0; i + 1 < fitted.particles.length; i++) {
              const particle = fitted.particles[i]!, next = fitted.particles[i + 1]!;
              if (particle.start + particle.duration >= next.start - 1e-7)
                particle.duration = durationBeforeNextPhase(particle.start, next.start);
            }
            if (recipe.sourceTint) for (const particle of fitted.particles) {
              const tint = [0, 0, 0]; let total = 0;
              for (let sample = 0; sample < 17; sample++) {
                const time = particle.start + particle.duration * (sample + .5) / 17;
                const gain = Math.max(0, Math.min(1, model.amplitude(time)));
                const rgb = model.peak.map((value: number) => {
                  const v = Math.min(1, value * gain);
                  return v <= .0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - .055;
                });
                const maximum = Math.max(...rgb), weight = maximum ** 2;
                total += weight;
                for (let c = 0; c < 3; c++) tint[c]! += (maximum > 0 ? rgb[c]! / maximum : 1) * weight;
              }
              // Fixed Source hue per existing stage; tint never adds a split.
              particle.color = "#" + tint.map((value) => Math.round((total > 0 ? value / total : 1) * 255).toString(16).padStart(2, "0")).join("");
            }
            groups.push({ count: 1, particles: fitted.particles });
            layers.push({ effect: name, ...identity, strategy: "source-peak-basis", critical: pair.critical,
              sourceTint: recipe.sourceTint, definitions: fitted.particles.length,
              maxCornerError: fitted.maxCornerError, maxAlphaError: fitted.maxAlphaError });
          }
          if (materialFits.length) {
            const centralDefinitions = centralMaster?.group.particles.length ?? 0,
              hardLimit = sourceProfile.limits.perEffectDefinitions[`${kind}W${width}`]! - centralDefinitions,
              target = (sourceProfile.limits.targetPerEffectDefinitions?.[`${kind}W${width}`] ?? hardLimit + centralDefinitions) - centralDefinitions,
              minimum = materialFits.reduce((sum, entry) => sum + entry.fit.pareto[0]!.count, 0),
              budget = Math.max(target, minimum);
            if (budget > hardLimit) throw new Error(`Source material minimum exceeds the admitted hard limit: ${name} ${budget}/${hardLimit}`);
            const allocated = allocateSourceMaterialBudget(materialFits.map((entry) => entry.fit.pareto), budget);
            allocated.selected.forEach((selected, index) => {
              const particles = selected.particles.filter((p) =>
                [...Object.values(p.a.from), ...Object.values(p.a.to)].some((value) => value !== 0));
              const geometryAudit = auditSourceMaterialTrajectory((previous.groups as ParticleGroup[])[materialFits[index]!.row.group]!.particles,
                particles, projects);
              if (geometryAudit.maximumPixelError > policy.maxPixelError960 + 1e-6)
                throw new Error(`Selected Source trajectory exceeds projection tolerance: ${name} ${index} ${geometryAudit.maximumPixelError}`);
              groups.push({ count: 1, particles });
              layers.push({ ...materialFits[index]!.row, definitions: particles.length, fittedStages: selected.count,
                zeroAlphaRemoved: selected.particles.length - particles.length,
                maxCornerError: selected.maxCornerError, relativeWeightedRms: selected.weightedRms,
                geometryAudit });
            });
            budgetProofs.push({ effect: name, budget, target, minimum, hardLimit, selected: groups.reduce((sum, group) => sum + group.particles.length, 0), fittedStages: allocated.count, pareto: allocated.pareto });
          }
          if (centralPolicy && centralMaster) {
            const target = sampled.particles.filter((p) => p.system === centralPolicy.system && p.sourceLayout?.width === width);
            const shared = shareSourceCentralPatch(centralMaster, centralSamples, target, centralPolicy.referenceWidth, width);
            for (const p of shared.group.particles) p.sprite = registerTile(centralMaster.tiles[p.sprite as number]!);
            groups.push(shared.group);
            centralPatches.push({ effect: name, system: centralPolicy.system, sourceActors: identities.filter((p) => p.system === centralPolicy.system),
              definitions: shared.group.particles.length, maximumPixelError: shared.maximumPixelError, pixelXScale: shared.pixelXScale,
              nativeXScale: shared.nativeXScale, referenceWidth: centralPolicy.referenceWidth, density: centralPolicy.density, frames: centralMaster.rows });
          }
          const delta = mergeParticleGroupDelta(data, png, { effects: [{ ...previous, groups }], atlas: packAtlas(tiles) },
            new Set(identities.map((i) => i.group)), decodeRgba8Png);
          data = delta.data; png = delta.png;
          const definitions = groups.reduce((n, g) => n + g.particles.length, 0);
          const budget = sourceProfile.limits.perEffectDefinitions[`${kind}W${width}`]!;
          if (definitions > budget) throw new Error(`Source material definition budget exceeded:${name} ${definitions}/${budget} ` + JSON.stringify(layers.filter((r) => r.effect === name).map((r) => ({ group:r.group, emission:r.emission, definitions:r.definitions }))));
          report.push({ key, kind, width, selectedGroups: identities.map((i) => i.group), actors: identities.length, groups: groups.length, definitions });
          const haloPolicy = sourceProfile.materials?.[kind]?.halo;
          if (haloPolicy) {
            const { appendSourceStarHalos } = await import("./native-particles/sourceStarHalo.ts");
            const halo = appendSourceStarHalos(data, png, sampled.particles.filter((p) => p.sourceLayout?.width === width), width,
              name.replace(/ P0$/, " B0"), { lifetime: 5 / 12, sourceScale: policy.renderingScale, ...haloPolicy });
            data = halo.data; png = halo.png; haloPatches.push(halo.proof);
          }
        }
      }
      tracer.dispose();
      const count = report.filter((r) => r.key === key).reduce((n, r) => n + r.definitions, 0);
      if (count > sourceProfile.limits.selectedDefinitions) throw new Error("Source material total definition budget exceeded");
      const packed = repackParticleAtlas(data, png, sourceProfile.limits.atlasSide, { denseSearch: true, decode: decodeRgba8Png, factorConstantTint: true });
      writeFileSync(resolve(output!, `${key}-hdr-material-proof.json`), JSON.stringify({ policy, materials: sourceProfile.materials, clocks: clockReport, layers, centralPatches, haloPatches, budgetProofs }, null, 2));
      return { data: packed.data, png: packed.png };
    }

    const result = await buildHdrMaterialPack(onlyProfile, onlyProfile === "standard" ? 0 : 2);
    writePack(onlyProfile, result.data, result.png);
    for (const key of ["standard", "light", "simple"]) {
      if (report.some((row) => row.key === key)) continue;
      mkdirSync(resolve(output, "particles", key), { recursive: true });
      const proof = `${key}-hdr-material-proof.json`;
      if (existsSync(resolve(baseline, proof))) copyFileSync(resolve(baseline, proof), resolve(output, proof));
      for (const n of ["particle.data", "particle.texture.png", "particle-pack-report.json"])
        copyFileSync(resolve(baseline, "particles", key, n), resolve(output, "particles", key, n));
    }
    // Retain the existing empty stage-proof contract without a program-rewriting pass.
    writeFileSync(resolve(output, "linearization-proof.json"), JSON.stringify({ report: [] }, null, 2));
    writeFileSync(resolve(output, "particle-packs.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(
      resolve(output, "star-delta-report.json"),
      JSON.stringify(
        {
          baseline,
          releaseRoot,
          producerRoot,
          sourceHashes,
          profiles: onlyProfile ? [onlyProfile] : ["standard", "light"],
          engineChanged: false,
          romChanged: false,
          mode: "Formal Source motion and central composite; native material recipe with fixed Source identities, births and clip lifetimes",
          report,
        },
        null,
        2,
      ),
    );

    return { directory: outputDirectory, report };
  } finally {
    hook?.deregister();
    if (previousFitReport === undefined) delete process.env.SONOLUS_FIT_REPORT;
    else process.env.SONOLUS_FIT_REPORT = previousFitReport;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [destination, baseline, releaseRoot, producerRoot, profile] = process.argv.slice(2);
  const profilePath = process.env.SONOLUS_STAR_PROFILE;
  if (!destination || !baseline || !releaseRoot || !producerRoot || !profilePath || (profile !== "standard" && profile !== "light"))
    throw new Error("Usage: SONOLUS_STAR_PROFILE=PROFILE build-native-source-star-assets.ts OUTPUT BASELINE RELEASE PRODUCER standard|light");
  await buildSourceStarAssets({ destination, baseline, releaseRoot, producerRoot, profilePath, profile,
    ...(process.env.SONOLUS_STAR_WIDTHS ? { widths: process.env.SONOLUS_STAR_WIDTHS.split(",").map(Number) } : {}),
  });
}
