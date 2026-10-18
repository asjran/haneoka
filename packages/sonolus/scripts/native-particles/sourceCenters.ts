import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { EffectTracer, unitsPerPixel, W_TO_H, type ParticleSample } from "./trace.ts";
import { bakeSourceBeam } from "./beamBake.ts";
import { packAtlas, responseAt, type Tile } from "./bake.ts";
import { fitSourceAlphaTrajectory, type TrajectoryParticle } from "./trajectory.ts";
import { decodeRgba8Png } from "../pack-original-note-skins.ts";
import { repackParticleAtlas } from "./repack.ts";
import type { ParticleData } from "./merge.ts";

type JsonRecord = Record<string, unknown>;
type ParticleGroup = { count: number; particles: TrajectoryParticle[] };
interface CenterTarget { name: string; width: number; groups: number[]; actorTextures: string[] }
interface CenterProfile {
  key: string; quality: number; baselineDataSha256: string; baselineTextureSha256: string;
  effects: CenterTarget[];
}
interface CenterRecipe {
  schema: string; atlasSide: number; sampleRate: number; referenceWidth: number;
  sourceRendererSha256: string; sourceAuthoredSha256: string;
  sourceSeed: number; verificationSeeds: number[]; profiles: CenterProfile[];
}
type CenterActor = Pick<ParticleSample, "system" | "texture" | "birth" | "lifetime">;
const hash = (bytes: Uint8Array, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const channel = (a: number, b = a) => ({ from: { c: a }, to: { c: b }, ease: a === b ? "none" : "linear" });
const peakOf = (samples: ParticleSample[]) => samples.filter((p) => Math.max(...p.emission) > 0 && p.pixelArea > 0)
  .reduce((a, b) => Math.max(...a.emission) * a.pixelArea >= Math.max(...b.emission) * b.pixelArea ? a : b);

/** The two deterministic centre billboards share materials while retaining each width's Source geometry and clock. */
export async function buildSourceCenterDelta(options: {
  destination: string; baseline: string; releaseRoot: string; recipePath: string;
  runtimeFiles: { renderer: string; authored: string; contract: string };
}) {
  const recipe: CenterRecipe = JSON.parse(readFileSync(options.recipePath, "utf8"));
  if (recipe.schema !== "our-notes-source-centers-v1" || recipe.atlasSide !== 1024 || recipe.sampleRate < 60)
    throw new Error("Invalid Source centre recipe");
  if (hash(readFileSync(options.runtimeFiles.renderer)) !== recipe.sourceRendererSha256 ||
      hash(readFileSync(options.runtimeFiles.authored)) !== recipe.sourceAuthoredSha256)
    throw new Error("Source centre runtime changed");
  const manifest = JSON.parse(readFileSync(resolve(options.baseline, "particle-packs.json"), "utf8"));
  const contract = JSON.parse(readFileSync(options.runtimeFiles.contract, "utf8"));
  const clip = 5 / 12, reports: JsonRecord[] = [];
  const spec = { kind: "flick" as const, direction: "none" as const, judgement: "perfect" as const, lifetime: clip };
  mkdirSync(options.destination, { recursive: true });
  for (const profile of recipe.profiles) {
    const baselinePath = resolve(options.baseline, "particles", profile.key);
    const oldBytes = readFileSync(resolve(baselinePath, "particle.data")), oldPng = readFileSync(resolve(baselinePath, "particle.texture.png"));
    if (hash(oldBytes) !== profile.baselineDataSha256 || hash(oldPng) !== profile.baselineTextureSha256)
      throw new Error("Source centre baseline changed");
    const base = JSON.parse(gunzipSync(oldBytes).toString()) as ParticleData;
    const oldImage = decodeRgba8Png(oldPng, "Source centre baseline");
    const tracer = new EffectTracer({ releaseRoot: options.releaseRoot, currentQuality: profile.quality, noteEffectSkin: "effect001" });
    await tracer.load();
    const sampled = new Map<number, ParticleSample[]>(), identities = new Map<number, CenterActor[]>();
    for (const target of profile.effects) {
      const seeds = [recipe.sourceSeed, ...recipe.verificationSeeds];
      const coarse = tracer.trace(spec, target.width, Array.from({ length: 26 }, (_, i) => i / 60), seeds, { meshes: false });
      const beams = coarse.particles.filter((p) => target.actorTextures.includes(p.texture));
      const actors = [...new Set(beams.map((p) => p.system))].map((system) => {
        const first = beams.filter((p) => p.system === system && p.seed === recipe.sourceSeed);
        if (!first.length) throw new Error("Source centre actor missing");
        for (const seed of recipe.verificationSeeds) {
          const other = beams.filter((p) => p.system === system && p.seed === seed);
          if (other.length !== first.length || other.some((p, i) =>
            JSON.stringify(p.corners) !== JSON.stringify(first[i]!.corners) ||
            JSON.stringify(p.emission) !== JSON.stringify(first[i]!.emission)))
            throw new Error("Source centre actor requires random geometry or material");
        }
        return { system, texture: first[0]!.texture, birth: first[0]!.birth, lifetime: first[0]!.lifetime };
      });
      if (actors.length !== 2) throw new Error("Expected two centre actors");
      identities.set(target.width, actors);
      const systems = new Set(actors.map((a) => a.system));
      sampled.set(target.width, tracer.trace(spec, target.width,
        Array.from({ length: Math.ceil(clip * recipe.sampleRate) + 1 }, (_, i) => i / recipe.sampleRate),
        [recipe.sourceSeed], { meshes: false, particle: (p) => systems.has(p.system) }).particles);
    }
    const reference = sampled.get(recipe.referenceWidth);
    if (!reference) throw new Error("Missing centre material reference width");
    const kernels = new Map<string, { tile: Tile; peak: ParticleSample }>();
    for (const texture of ["centerPillar", "centerPillar02"]) {
      const peak = peakOf(reference.filter((p) => p.texture === texture));
      kernels.set(texture, { peak, tile: bakeSourceBeam(profile.key + "|shared|" + texture, peak,
        recipe.referenceWidth / 4, contract.nativeEffects.planes[0]) });
    }
    const tiles: Tile[] = [], tileIds = new Map<string, number>();
    const register = (tile: Tile) => {
      const key = tile.image.width + ":" + tile.image.height + ":" + hash(tile.image.pixels);
      const present = tileIds.get(key); if (present !== undefined) return present;
      const id = tiles.length; tiles.push(tile); tileIds.set(key, id); return id;
    };
    const copyGroup = (group: ParticleGroup) => ({ ...group, particles: group.particles.map((particle) => {
      const s = base.sprites[particle.sprite]!, pixels = new Uint8Array(s.w * s.h * 4);
      for (let y = 0; y < s.h; y++) pixels.set(oldImage.pixels.subarray(
        ((s.y + y) * oldImage.width + s.x) * 4, ((s.y + y) * oldImage.width + s.x + s.w) * 4), y * s.w * 4);
      return { ...particle, sprite: register({ key: "baseline", image: { width: s.w, height: s.h, pixels },
        expand: [1, 1], offset: [0, 0], response: new Float32Array(9).fill(1) }) };
    }) });
    const deltas = new Map<string, ParticleGroup[]>();
    for (const target of profile.effects) {
      const before = base.effects.find((e) => e.name === target.name);
      if (!before || target.groups.length !== 2 || target.groups.some((g: number) => g < 0 || g >= (before.groups as ParticleGroup[]).length))
        throw new Error("Invalid Source centre group mapping");
      const groups: ParticleGroup[] = [];
      for (const texture of target.actorTextures as string[]) {
        const actor = identities.get(target.width)!.find((a) => a.texture === texture)!;
        const samples = sampled.get(target.width)!.filter((p) => p.texture === texture), peak = peakOf(samples);
        const own = bakeSourceBeam(profile.key + "|W" + target.width + "|" + texture, peak,
          target.width / 4, contract.nativeEffects.planes[0]);
        const kernel = kernels.get(texture)!, sprite = register(kernel.tile);
        const values = samples.map((p) => {
          const xs = p.corners.map((c) => c.x), ys = p.corners.map((c) => c.y);
          const w = (Math.max(...xs) - Math.min(...xs)) / 2, h = (Math.max(...ys) - Math.min(...ys)) / 2;
          return { t: p.t, x: (Math.max(...xs) + Math.min(...xs)) / 2 + 2 * w * own.offset[0],
            y: (Math.max(...ys) + Math.min(...ys)) / 2 + 2 * h * own.offset[1],
            w: w * own.expand[0], h: h * own.expand[1], r: 0,
            a: Math.max(...p.emission) > 0 ? responseAt(kernel.tile, Math.max(...p.emission) / Math.max(...kernel.peak.emission)) : 0 };
        });
        if (values[0]!.t > actor.birth + 1e-8) values.unshift({ ...values[0]!, t: actor.birth, w: 0, h: 0, a: 0 });
        const death = actor.birth + actor.lifetime;
        if (values.at(-1)!.t < death) values.push({ ...values.at(-1)!, t: death, a: 0 });
        const raw: TrajectoryParticle[] = [];
        for (let i = 1; i < values.length; i++) {
          const a = values[i - 1]!, b = values[i]!;
          if (b.t <= a.t || Math.max(a.a, b.a) <= 0) continue;
          raw.push({ sprite, color: "#ffffff", start: a.t / clip, duration: (b.t - a.t) / clip,
            ...Object.fromEntries((["x", "y", "w", "h", "r", "a"] as const).map((c) => [c, channel(a[c], b[c])])) } as TrajectoryParticle);
        }
        const units = unitsPerPixel(target.width / 4), plane = contract.nativeEffects.planes[0];
        const project = (x: number, y: number): readonly [number, number] =>
          [(x / units.x) * (plane.alpha1 - plane.slope * W_TO_H * (y + 1)), y / units.y];
        const alphaAt = (time: number) => {
          const t = time * clip; let a = values[0]!;
          for (const b of values) { if (b.t >= t) { const q = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0; return a.a + (b.a - a.a) * q; } a = b; }
          return 0;
        };
        const fitted = fitSourceAlphaTrajectory(raw, { alpha: alphaAt, knots: [],
          zeroKnots: values.filter((p, i) => p.a === 0 && ((i > 0 && values[i - 1]!.a > 0) || (i + 1 < values.length && values[i + 1]!.a > 0))).map((p) => p.t / clip),
          projects: [project], maxPixelError: .35, maxAlphaError: 1 / 255, sprite });
        const compressed = { particles: fitted.particles, report: { input: raw.length, output: fitted.particles.length,
          maxCornerError: fitted.maxCornerError, maxAlphaError: fitted.maxAlphaError, eases: "polynomial-only" } };
        const particles = compressed.particles.map((p, i, all) => ({ ...p, duration:
          i + 1 < all.length && p.start + p.duration >= all[i + 1]!.start - 1e-8 ?
            Math.max(0, all[i + 1]!.start - p.start - 1e-6) : p.duration }));
        groups.push({ count: 1, particles });
        reports.push({ profile: profile.key, width: target.width, texture, ...actor as Omit<CenterActor, "texture">,
          sixSeedGeometryAndEmissionExact: true, referenceWidth: recipe.referenceWidth,
          peakTime: peak.t, definitions: particles.length, compression: compressed.report,
          blackTimes: values.filter((p) => p.a === 0).map((p) => p.t) });
      }
      deltas.set(target.name, groups);
    }
    const effects = base.effects.map((effect) => {
      const target = profile.effects.find((t) => t.name === effect.name);
      if (!target) return { ...effect, groups: (effect.groups as ParticleGroup[]).map(copyGroup) };
      return { ...effect, groups: (effect.groups as ParticleGroup[]).flatMap((g, i) => {
        const actor = target.groups.indexOf(i); return actor < 0 ? [copyGroup(g)] : [deltas.get(String(effect.name))![actor]!];
      }) };
    });
    const atlas = packAtlas(tiles), packed = repackParticleAtlas({ ...base, width: atlas.width, height: atlas.height,
      sprites: atlas.sprites, effects } as ParticleData, atlas.png, recipe.atlasSide, { denseSearch: true, decode: decodeRgba8Png });
    const output = resolve(options.destination, "particles", profile.key); mkdirSync(output, { recursive: true });
    const bytes = gzipSync(JSON.stringify(packed.data), { level: 9 });
    writeFileSync(resolve(output, "particle.data"), bytes); writeFileSync(resolve(output, "particle.texture.png"), packed.png);
    const pack = JSON.parse(readFileSync(resolve(baselinePath, "particle-pack-report.json"), "utf8"));
    pack.artifacts = { data: { bytes: bytes.length, sha1: hash(bytes, "sha1") },
      texture: { bytes: packed.png.length, sha1: hash(packed.png, "sha1") } };
    pack.atlas = { width: packed.data.width, height: packed.data.height, sprites: packed.data.sprites.length };
    pack.definitions = packed.data.effects.reduce((n, e) => n + (e.groups as ParticleGroup[]).reduce((m, g) => m + g.count * g.particles.length, 0), 0);
    pack.sourceCenters = { proof: "source-centers-proof.json", referenceWidth: recipe.referenceWidth };
    writeFileSync(resolve(output, "particle-pack-report.json"), JSON.stringify(pack, null, 2));
    manifest.packs = manifest.packs.map((p: { key: string }) => p.key === profile.key ? pack : p);
    tracer.dispose();
  }
  const simple = resolve(options.destination, "particles/simple"); mkdirSync(simple, { recursive: true });
  for (const file of ["particle.data", "particle.texture.png", "particle-pack-report.json"])
    copyFileSync(resolve(options.baseline, "particles/simple", file), resolve(simple, file));
  writeFileSync(resolve(options.destination, "particle-packs.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(resolve(options.destination, "source-centers-proof.json"), JSON.stringify({ schema: recipe.schema,
    recipeSha256: hash(readFileSync(options.recipePath)), sourceRendererSha256: recipe.sourceRendererSha256,
    sceneAggregateCompensation: false, sourceHashes: Object.fromEntries([
      "sourceCenters.ts", "trace.ts", "beamBake.ts", "bake.ts", "trajectory.ts", "fit.ts", "repack.ts", "rectanglePacking.ts", "textureBake.ts", "../pack-original-note-skins.ts",
    ].map((file) => [file, hash(readFileSync(resolve(import.meta.dirname, file)))])), rows: reports }, null, 2));
}
