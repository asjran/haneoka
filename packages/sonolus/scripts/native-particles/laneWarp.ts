import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { RenderParticleEffect } from "@haneoka/cassiopeia-plugin-our-notes";
import { decodeRgba8Png } from "../pack-original-note-skins.ts";
import type { Tile } from "./bake.ts";
import { EffectTracer, W_TO_H, type LaneSurfaceSample } from "./trace.ts";

type Rgb = readonly [number, number, number];
type Channel = { from: Record<string, number>; to: Record<string, number>; ease: "none" | "linear" };
type Definition = { sprite: number; color: string; start: number; duration: number;
  x: Channel; y: Channel; w: Channel; h: Channel; r: Channel; a: Channel };
interface Field {
  surface: LaneSurfaceSample; a: number; b: number; c: number; d: number; near: number; strength: number;
}
const LIFETIME = .44999998807907104 / 2;
const STEP = 1 / 240;
const PIXELS_PER_UNIT_Y = W_TO_H * (1.115119873136453 + .5815420740473228) * 540;
const TILE_WIDTH = 64;
const UPPER_CUT = .6458333333333334;
const PHASE_GRID = 2 ** 24;
// Native SrcAlpha/OneMinusSrcAlpha attenuates the stage beneath Source's
// additive lane feedback. This hue-preserving calibration uses the reviewed
// six-stage composition; quantize first to reproduce the approved RGBA tiles.
export const SOURCE_LANE_NATIVE_ALPHA_GAIN = 1.10;
const JUDGE_ALPHA_GAINS: Readonly<Partial<Record<RenderParticleEffect["kind"], number>>> = {
  "lane-effect-normal": 1.17,
  "lane-effect-slide": 1.17,
  "lane-effect-flick": 1.12,
  "lane-effect-flick-right": 1.14,
};
const constant = (c: number): Channel => ({ from: c ? { c } : {}, to: c ? { c } : {}, ease: "none" });
const linear = (a: number, b: number): Channel => a === b ? constant(a) :
  { from: a ? { c: a } : {}, to: b ? { c: b } : {}, ease: "linear" };
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const maxRgb = (rgb: Rgb) => Math.max(...rgb);
export const SOURCE_LANE_EFFECTS = [
  { label: "In Vain", kind: "lane-input-blank-miss", asset: "inVain" },
  { label: "Normal", kind: "lane-effect-normal", asset: "normal" },
  { label: "Slide", kind: "lane-effect-slide", asset: "slide" },
  { label: "Flick", kind: "lane-effect-flick", asset: "flick" },
  { label: "Flick Left", kind: "lane-effect-flick-left", asset: "flickLeft" },
  { label: "Flick Right", kind: "lane-effect-flick-right", asset: "flickRight" },
] as const;

/** Source perspective UV and the final native resources share this one mapping. */
export function laneUvAt(field: Pick<Field, "a" | "b" | "c" | "d">, y: number): number {
  return (field.a - y * field.c) / (y * field.d - field.b);
}

function timeline(times: readonly number[], values: readonly (readonly number[])[], tolerance: readonly number[]) {
  const cuts = new Set([0, times.length - 1]);
  const split = (first: number, last: number): void => {
    let worst = 1, at = -1;
    for (let i = first + 1; i < last; i++) {
      const q = (times[i]! - times[first]!) / (times[last]! - times[first]!);
      for (let c = 0; c < tolerance.length; c++) {
        const expected = values[first]![c]! + (values[last]![c]! - values[first]![c]!) * q;
        const error = Math.abs(expected - values[i]![c]!) / tolerance[c]!;
        if (error > worst) { worst = error; at = i; }
      }
    }
    if (at >= 0) { cuts.add(at); split(first, at); split(at, last); }
  };
  split(0, times.length - 1);
  return [...cuts].sort((a, b) => a - b);
}

export interface CompiledLaneWarp {
  tiles: Tile[];
  groups: Array<{ tile: string; particles: Omit<Definition, "sprite">[] }>;
  report: Record<string, unknown>;
}
export interface LaneWarpBudget {
  lowerBands?: number;
  upperErrorPixels?: number;
}

/** Four disjoint bands cover the Source ground quad through its actual camera near plane. */
export function compileSourceLaneWarp(tracer: EffectTracer, kind: RenderParticleEffect["kind"], name: string,
  budget: LaneWarpBudget = {}): CompiledLaneWarp {
  const lowerBands = budget.lowerBands ?? 2, upperErrorPixels = budget.upperErrorPixels ?? 8;
  if (lowerBands !== 2 ||
    !Number.isFinite(upperErrorPixels) || upperErrorPixels <= 0 || upperErrorPixels > 16)
    throw new Error("Invalid Source lane warp budget");
  const source = SOURCE_LANE_EFFECTS.find((entry) => entry.kind === kind);
  if (!source) throw new Error(`Unsupported Source lane kind: ${kind}`);
  const metadataPath = tracer.assets.particles.laneEffects[source.asset].particleSystemMetadataUrl;
  const metadataBytes = readFileSync(metadataPath), metadata = JSON.parse(metadataBytes.toString()).data;
  if (metadata.InitialModule.startLifetime.minMaxState !== 0 ||
    metadata.InitialModule.startLifetime.scalar / metadata.simulationSpeed !== LIFETIME ||
    metadata.ColorModule.enabled !== true || metadata.ColorModule.gradient.minMaxState !== 1)
    throw new Error(`Unsupported Source lane timing: ${name}`);
  const gradient = metadata.ColorModule.gradient.maxGradient;
  const alphaEdges = Array.from({ length: gradient.m_NumAlphaKeys as number }, (_, i) =>
    Number(gradient[`atime${i}`]) / 65535 * LIFETIME);
  const times = [...new Set([0, ...Array.from({ length: Math.ceil(LIFETIME / STEP) }, (_, i) => i * STEP),
    ...alphaEdges, LIFETIME])].sort((a, b) => a - b);
  const rawSurfaces = tracer.traceLaneSurfaces(kind, 1, times);
  if (!rawSurfaces.length) throw new Error(`Missing authored lane surfaces: ${name}`);
  const surfaces = times.map((t) => {
    const actual = rawSurfaces.find((s) => Math.abs(s.t - t) < 1e-10);
    if (actual) return actual;
    if (t < LIFETIME - .002) throw new Error(`Missing visible lane surface: ${name} ${t}`);
    const previous = rawSurfaces.filter((s) => s.t < t).at(-1)!;
    return { ...previous, t, emission: [0, 0, 0] as Rgb };
  });
  const fields: Field[] = surfaces.map((surface) => {
    const p0 = tracer.projectLaneUV(surface.quad, .5, 0, .25);
    const p1 = tracer.projectLaneUV(surface.quad, .5, 1, .25);
    const a = p0.y * p0.depth;
    return { surface, a, b: p1.y * p1.depth - a, c: p0.depth, d: p1.depth - p0.depth, near: Math.fround(p0.near),
      strength: maxRgb(surface.emission) };
  });
  const peak = fields.reduce((best, f) => f.strength > best.strength ? f : best);
  const peakColor = peak.surface.emission;
  const imageBytes = readFileSync(peak.surface.file);
  const image = decodeRgba8Png(imageBytes, peak.surface.file);
  const texel = (u: number, v: number): readonly [number, number, number, number] => {
    const px = clamp(u) * image.width - .5, py = (1 - clamp(v)) * image.height - .5;
    const x0 = Math.floor(px), y0 = Math.floor(py), dx = px - x0, dy = py - y0;
    const channels = [0, 0, 0, 0];
    for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) {
      const x = Math.max(0, Math.min(image.width - 1, x0 + xx));
      const y = Math.max(0, Math.min(image.height - 1, y0 + yy));
      const weight = (xx ? dx : 1 - dx) * (yy ? dy : 1 - dy);
      for (let c = 0; c < 4; c++) channels[c]! += image.pixels[(y * image.width + x) * 4 + c]! / 255 * weight;
    }
    return [channels[0]!, channels[1]!, channels[2]!, channels[3]!];
  };
  const emissionAt = (field: Field, u: number, y: number): Rgb => {
    const v = laneUvAt(field, y), depth = field.c + field.d * v;
    if (v < 0 || v > 1 || depth + (Math.abs(field.c) + Math.abs(field.d * v)) * Number.EPSILON * 4 < field.near)
      return [0, 0, 0];
    const t = texel(u, v), alpha = t[3];
    return [t[0] * alpha * field.surface.emission[0], t[1] * alpha * field.surface.emission[1],
      t[2] * alpha * field.surface.emission[2]];
  };
  const judge = tracer.projectLaneUV(surfaces[0]!.quad, .5, .5, .25).y;
  if (Math.abs(judge + 1) > 1e-8) throw new Error(`Invalid Source lane judgment: ${name}`);
  const sourceWidth = tracer.projectLaneUV(surfaces[0]!.quad, 1, .5, .25).x;
  if (!(sourceWidth > 0) || !Number.isFinite(sourceWidth) ||
    surfaces.some((s) => Math.abs(tracer.projectLaneUV(s.quad, 1, .5, .25).x - sourceWidth) > 1e-7))
    throw new Error(`Animated Source lane width is not supported: ${name}`);
  const nearIntersections = fields.map((field) => {
    const v = (field.near - field.c) / field.d;
    if (!(v > 0 && v < .5)) throw new Error(`Source lane does not cross camera near: ${name}`);
    return { uv: v, y: (field.a + field.b * v) / field.near };
  });
  const sourceNear = Math.min(...nearIntersections.map((point) => point.y));
  if (Math.max(...nearIntersections.map((point) => point.y)) - sourceNear > 1e-6)
    throw new Error(`Source lane is not a fixed ground plane: ${name}`);
  const lower = Math.fround(sourceNear);
  const bodyBottom = -16;
  if (!(lower < bodyBottom)) throw new Error(`Source lane near domain is too short: ${name}`);
  const chroma = peakColor.map((value) => value / peak.strength) as unknown as Rgb;
  for (const field of fields)
    if (field.strength > 0 && field.surface.emission.some((value, c) =>
      Math.abs(value / field.strength - chroma[c]!) > 1e-8))
      throw new Error(`Source lane colour changes over lifetime: ${name}`);
  for (let i = 0; i < image.pixels.length; i += 4)
    if (image.pixels[i] !== image.pixels[i + 1] || image.pixels[i] !== image.pixels[i + 2])
      throw new Error(`Source lane texture is not grayscale: ${name}`);
  const bodyRatios = fields.map((field) => field.strength / peak.strength);
  const pointwiseMinimax = (u: number, y: number): Rgb => {
    const values = fields.map((field) => maxRgb(emissionAt(field, u, y)));
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < values.length; i++) if (bodyRatios[i]! > 0) {
      const candidate = values[i]! / bodyRatios[i]!;
      lo = Math.min(lo, candidate); hi = Math.max(hi, candidate);
    }
    for (let step = 0; step < 24; step++) {
      const candidate = (lo + hi) / 2;
      let positive = 0, negative = 0;
      for (let i = 0; i < values.length; i++) {
        const error = values[i]! - bodyRatios[i]! * candidate;
        positive = Math.max(positive, error); negative = Math.max(negative, -error);
      }
      if (positive > negative) lo = candidate; else hi = candidate;
    }
    const value = (lo + hi) / 2;
    return [chroma[0] * value, chroma[1] * value, chroma[2] * value];
  };
  const tailUvs = fields.map((field, i) => {
    const first = nearIntersections[i]!.uv, last = laneUvAt(field, bodyBottom);
    const values = [first, last];
    for (let row = 0; row < image.height * 2; row++) {
      const v = 1 - (row + .5) / (image.height * 2);
      if (v > first && v < last) values.push(v);
    }
    return values;
  });
  const tailValue = (u: number, index: number): number => {
    let lo = Infinity, hi = -Infinity;
    for (const v of tailUvs[index]!) {
      const sample = texel(u, v), intensity = Math.max(sample[0], sample[1], sample[2]) * sample[3] * fields[index]!.strength;
      lo = Math.min(lo, intensity); hi = Math.max(hi, intensity);
    }
    return (lo + hi) / 2;
  };
  const tailValues = fields.map((_, i) => tailValue(.5, i));
  const tailPeak = Math.max(...tailValues);
  const tailRatios = tailValues.map((value) => value / tailPeak);
  const tiles: Tile[] = [], groups: CompiledLaneWarp["groups"] = [];
  const nativeAlphaGain = kind === "lane-input-blank-miss" ? 1 : SOURCE_LANE_NATIVE_ALPHA_GAIN;
  const judgeAlphaGain = JUDGE_ALPHA_GAINS[kind] ?? nativeAlphaGain;
  const alphaGainAt = (y: number) => nativeAlphaGain +
    (judgeAlphaGain - nativeAlphaGain) * Math.exp(-(((y - judge) / .65) ** 2));
  const pixel = (rgb: Rgb, target: Uint8Array, offset: number, gain: number) => {
    const a = maxRgb(rgb);
    for (let c = 0; c < 3; c++) target[offset + c] = a > 0 ? Math.round(clamp(rgb[c]! / a) * 255) : 0;
    const alphaByte = Math.round(clamp(a) * 255);
    target[offset + 3] = Math.min(255, Math.round(alphaByte * gain));
  };
  const addTile = (key: string, height: number, sample: (u: number, q: number) => Rgb,
    stageY?: (q: number) => number) => {
    const pixels = new Uint8Array(TILE_WIDTH * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < TILE_WIDTH; x++)
      pixel(sample(x / (TILE_WIDTH - 1), y / (height - 1)), pixels, (y * TILE_WIDTH + x) * 4,
        stageY ? alphaGainAt(stageY(y / (height - 1))) : nativeAlphaGain);
    tiles.push({ key, image: { width: TILE_WIDTH, height, pixels }, expand: [1, 1], offset: [0, 0],
      response: Float32Array.from(Array.from({ length: 9 }, (_, i) => i / 8)) });
  };
  const append = (tile: string, cuts: readonly number[], at: (index: number) => { y: number; h: number; alpha: number }) => {
    const particles: Omit<Definition, "sprite">[] = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const first = cuts[i]!, last = cuts[i + 1]!, a = at(first), b = at(last);
      const start = Math.round(times[first]! / LIFETIME * PHASE_GRID) / PHASE_GRID;
      const end = Math.round(times[last]! / LIFETIME * PHASE_GRID) / PHASE_GRID;
      particles.push({ color: "#ffffff", start, duration: end - start,
        x: constant(0), y: linear(a.y, b.y),
        // Studio's none jumps at p==1; the outgoing serial piece collapses
        // on that shared instant while the incoming piece retains full width.
        w: { from: { c: sourceWidth }, to: {}, ease: "none" }, h: linear(a.h, b.h),
        r: constant(0), a: linear(a.alpha, b.alpha) });
    }
    groups.push({ tile, particles });
    return particles;
  };
  const tailKey = `lane-warp|${name}|near-tail`;
  addTile(tailKey, 8, (u) => {
    const value = Math.max(...fields.map((_, i) => tailValue(u, i)));
    return [chroma[0] * value, chroma[1] * value, chroma[2] * value];
  });
  const tailCuts = timeline(times, tailRatios.map((value) => [value]), [1 / (255 * tailPeak)]);
  append(tailKey, tailCuts, (index) => ({ y: (lower + bodyBottom) / 2,
    h: (bodyBottom - lower) / 2, alpha: tailRatios[index]! }));
  const bodyKey = `lane-warp|${name}|body`;
  addTile(bodyKey, 512, (u, q) => pointwiseMinimax(u, judge + (bodyBottom - judge) * q),
    (q) => judge + (bodyBottom - judge) * q);
  const bodyCuts = timeline(times, bodyRatios.map((value) => [value]), [.75 / (255 * peak.strength)]);
  append(bodyKey, bodyCuts, (index) => ({ y: (bodyBottom + judge) / 2,
    h: (judge - bodyBottom) / 2, alpha: bodyRatios[index]! }));
  const upperVs = [.5, UPPER_CUT, 1];
  const upperYs = surfaces.map((s) => upperVs.map((v) => tracer.projectLaneUV(s.quad, .5, v, .25).y));
  const upperValues = upperYs.map((row, i) => [...row, fields[i]!.strength / peak.strength]);
  const upperCuts = timeline(times, upperValues, [1e-8, upperErrorPixels / PIXELS_PER_UNIT_Y, upperErrorPixels / PIXELS_PER_UNIT_Y,
    .75 / (255 * peak.strength)]);
  const reference = fields.reduce((best, f) => Math.abs(f.surface.t - 2 / 60) < Math.abs(best.surface.t - 2 / 60) ? f : best);
  for (let i = 0; i < 2; i++) {
    const v0 = upperVs[i]!, v1 = upperVs[i + 1]!;
    const y0 = tracer.projectLaneUV(reference.surface.quad, .5, v0, .25).y;
    const y1 = tracer.projectLaneUV(reference.surface.quad, .5, v1, .25).y;
    const key = `lane-warp|${name}|upper${i}`;
    const program = append(key, upperCuts, (index) => ({ y: (upperYs[index]![i]! + upperYs[index]![i + 1]!) / 2,
      h: (upperYs[index]![i + 1]! - upperYs[index]![i]!) / 2, alpha: fields[index]!.strength / peak.strength }));
    const phase = (2 / 60) / LIFETIME;
    const piece = program.find((particle) => phase >= particle.start && phase < particle.start + particle.duration)!;
    const progress = (phase - piece.start) / piece.duration;
    const atReference = (channel: Channel) => (channel.from.c ?? 0) +
      ((channel.to.c ?? 0) - (channel.from.c ?? 0)) * (channel.ease === "linear" ? progress : 0);
    const bandY = atReference(piece.y), bandH = atReference(piece.h);
    const bandTop = bandY + bandH, bandBottom = bandY - bandH;
    addTile(key, 128, (u, q) => {
      const v = laneUvAt(reference, y1 + (y0 - y1) * q), t = texel(u, v);
      return [t[0] * t[3] * peakColor[0], t[1] * t[3] * peakColor[1], t[2] * t[3] * peakColor[2]];
    }, i === 0 ? (q) => bandTop + (bandBottom - bandTop) * q : undefined);
  }
  return { tiles, groups, report: { name, policy: "Source near-clipped tail plateau, minimax body and moving upper2 UV bands", lifetime: LIFETIME,
    budget: { lowerBands, upperErrorPixels },
    nativeComposition: { blend: "SrcAlpha/OneMinusSrcAlpha", sourceBlend: "One/One",
      encodedAlphaGain: nativeAlphaGain, quantization: "round(SourceAlpha*255), then round(byte*gain)",
      localJudge: { peakAlphaGain: judgeAlphaGain, centreStageY: judge, sigmaStageY: .65,
        bands: ["body", "upper0"], upperReferenceSeconds: 2 / 60,
        upperCoordinates: "Serialized band placement; RGB/programmes/timing unchanged" },
      calibration: "Six published stage underlays; RGB/hue, program alpha and timing retained" },
    phases: times.length, bands: groups.length, sourceTexture: peak.surface.file,
    sourceTextureSha256: createHash("sha256").update(imageBytes).digest("hex"), judgmentUnitY: judge,
    sourceMetadata: metadataPath, sourceMetadataSha256: createHash("sha256").update(metadataBytes).digest("hex"),
    sourceHalfWidth: sourceWidth, lowerBounds: [lower, judge],
    cameraNear: fields[0]!.near, sourceNearY: sourceNear, nearUVRange: [Math.min(...nearIntersections.map((p) => p.uv)), Math.max(...nearIntersections.map((p) => p.uv))],
    lowerBands: [{ lo: lower, hi: bodyBottom, model: "phase-wise Source tail plateau" },
      { lo: bodyBottom, hi: judge, model: "pointwise Source temporal minimax at authored alpha", textureHeight: 512 }],
    upperUvBounds: upperVs, definitions: groups.reduce((sum, g) => sum + g.particles.length, 0),
    activeQuads: groups.length, nativeAreaPartition: "Disjoint boundaries; lower/upper meet at exact Source UV.5 judgment",
    frameEndGapSeconds: 0, endpointPolicy: "Constant Source width; none-ease collapses only exact outgoing endpoint",
    phaseGrid: PHASE_GRID, maximumPhaseQuantizationSeconds: .5 / PHASE_GRID * LIFETIME } };
}
