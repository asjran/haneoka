// Compiles the Our Notes effect001 hit effects into native Sonolus particle
// effects.
//
//  1. trace.ts samples the web renderer's own evaluator for several seeds.
//  2. Every textured quad becomes a Sonolus sprite tile with its HDR colour and
//     bloom halo baked in (bake.ts).
//  3. Deterministic rigs (wall, frame, pillars, lane fill) are fitted as
//     piecewise channels; random particle systems are grouped into cohorts of
//     consecutive emissions whose channels are linear in r1..r8, the same
//     eight Unity draws sampleParticle uses. Each Sonolus instance therefore
//     re-randomizes exactly like a native hit.
//  4. Effects are authored for several chart widths so sprite aspect survives
//     wide notes; the engine picks the nearest width and stretches the rest.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NoteSimulateJudgement } from "@haneoka/cassiopeia";
import { nativeParticleEffectLifetime, type RenderParticleEffect } from "@haneoka/cassiopeia-plugin-our-notes";
import {
  bakeCompositeHalo,
  bloomKernel,
  HALO_KERNEL,
  RIG_BLOOM_MIPS,
  RIG_GLOW_KERNEL,
  RIG_HALO_MIPS,
  SPRITE_BLOOM_MIPS,
  bakeKernelTile,
  bakeTile,
  kernelAlpha,
  packAtlas,
  prefilteredFlux,
  responseAt,
  type BloomKernel,
  type Tile,
} from "./bake.ts";
import {
  capToCeiling,
  expressionJson,
  fitChannel,
  raiseToFloor,
  type ChannelFit,
  type EaseName,
  type Observation,
} from "./fit.ts";
import { ease } from "./fit.ts";
import { EffectTracer, unitsPerPixel, type ParticleSample, type QuadSample, type TextureKey } from "./trace.ts";

interface NativeEffectContract {
  nativeEffects: {
    profiles: readonly string[];
    profileQualities: readonly number[];
    /** Authored NoteEffectSkin asset for each profile (defaults to effect001). */
    profileSkins?: readonly ("effect001" | "effect001Simple")[];
    widths: readonly number[];
    planes: readonly { label: string; alpha1: number; slope: number }[];
    baseNames: Readonly<Record<string, string>>;
  };
}

const nativeEffectContract = JSON.parse(
  readFileSync(fileURLToPath(import.meta.resolve("@haneoka/sonolus-our-notes/contract/native-effects.json")), "utf8"),
) as NativeEffectContract;
const nativeEffects = nativeEffectContract.nativeEffects;

/** Chart widths with their own authored effects (84% of notes are 6 or 8). */
export const NATIVE_EFFECT_WIDTHS = nativeEffects.widths;

const SEEDS = [0x4f4e, 0x1234, 0xbeef, 0x51a7, 0x7777, 0x2468];
const SAMPLE_STEP = 1 / 60;
/** Eases considered for random cohorts; rigs use the full set. */
const COHORT_EASES: readonly EaseName[] = [
  "linear",
  "inQuad",
  "outQuad",
  "inOutQuad",
  "inCubic",
  "outCubic",
  "outQuart",
  "outExpo",
  "inExpo",
  "outCirc",
  "inOutSine",
];
const MAX_FEATURES = 4;
const COHORT_SIZE = 8;
/** Dense-swarm HDR bloom (swarmBloomGroups). */
const SWARM_KEYFRAMES = 4;
const SWARM_DENSITY = 1 / 6;
const SWARM_VISIBILITY = Number(process.env.SONOLUS_SWARM_VISIBILITY ?? Infinity);
const VELOCITY_BINS = Number(process.env.SONOLUS_VELOCITY_BINS ?? 2);
const LIFETIME_SPREAD = 0.1;
const MAX_LIFETIME_BINS = Number(process.env.SONOLUS_LIFETIME_BINS ?? 4);
/** SONOLUS_FIT_REPORT: per-cohort fit error relative to the channel mean (x/y per 20 px). */
export const fitReport: string[] = [];
/** Star near bloom: per-star halo particles baked from mips 1..STAR_HALO_MIPS-1. */
const STAR_HALOS = process.env.SONOLUS_STAR_HALOS === "1";
const STAR_HALO_MIPS = 3;
/** Slots born within this many seconds share one Sonolus group. */
const BIRTH_WINDOW = 1 / 120;
const MAX_MESH_PIECES = 6;
const MAX_COHORT_PIECES = Number(process.env.SONOLUS_COHORT_PIECES ?? 2);
/** Halo particles are only authored for cohorts whose halo is visible. */
// Measured against the web renderer, separate halos cost more error than the
// near bloom they add, so they are off unless requested (e.g. 0.03).
const HALO_VISIBILITY = Number(process.env.SONOLUS_PARTICLE_HALO_VISIBILITY ?? "2");
/**
 * Unity draws (trace.ts DRAW_OFFSETS: shape x/y/z, lifetime, size, velocity,
 * rotation, colour) that physically drive each Sonolus channel.
 */
const CHANNEL_DRAWS: Readonly<Record<"x" | "y" | "w" | "h" | "r" | "a", readonly number[]>> = {
  // Velocity-over-lifetime is evaluated at normalized age: the lifetime
  // draw (3) moves every particle's path, not only its fade.
  x: [0, 1, 2, 5, 3],
  y: [0, 1, 2, 5, 3],
  w: [4],
  h: [4],
  r: [6],
  a: [3, 4],
};
const POSITION_TOLERANCE = 0.03;
const ALPHA_TOLERANCE = 0.04;
/** Calibrated against the web renderer in the Sonolus preview harness. */
const BLOOM_GAIN = Number(process.env.SONOLUS_PARTICLE_BLOOM_GAIN ?? "1");

export interface EffectSpec {
  name: string;
  kind: RenderParticleEffect["kind"];
  direction: RenderParticleEffect["direction"];
  judgement: RenderParticleEffect["judgement"];
  lifetime: number;
  loop?: { period: number };
  /** Lane fills are drawn by the base camera: no bloom, ground layout. */
  lane?: boolean;
}

const JUDGEMENTS = [
  { suffix: "", judgement: "perfect", native: NoteSimulateJudgement.Perfect },
  { suffix: " Great", judgement: "great", native: NoteSimulateJudgement.Great },
  { suffix: " Good", judgement: "good", native: NoteSimulateJudgement.Good },
  { suffix: " Bad", judgement: "bad", native: NoteSimulateJudgement.Bad },
] as const;

const NOTE_KINDS = [
  { label: nativeEffects.baseNames.normalNoteCircular!, kind: "tap", direction: "none" },
  { label: nativeEffects.baseNames.slideNoteCircular!, kind: "slide", direction: "none" },
  { label: nativeEffects.baseNames.flickNoteCircular!, kind: "flick", direction: "up" },
  { label: nativeEffects.baseNames.flickLeftWall!, kind: "flick", direction: "left" },
  { label: nativeEffects.baseNames.flickRightWall!, kind: "flick", direction: "right" },
  { label: nativeEffects.baseNames.normalTraceNoteCircular!, kind: "connect", direction: "none" },
] as const;

const LANE_KINDS = [
  { label: "In Vain", kind: "lane-input-blank-miss" },
  { label: "Normal", kind: "lane-effect-normal" },
  { label: "Slide", kind: "lane-effect-slide" },
  { label: "Flick", kind: "lane-effect-flick" },
  { label: "Flick Left", kind: "lane-effect-flick-left" },
  { label: "Flick Right", kind: "lane-effect-flick-right" },
] as const;

export const nativeEffectName = (base: string, width: number): string => `${base} W${width}`;

/**
 * Plane layers. Every effect001 quad lies on a plane containing the world x
 * axis, where the on-screen lane offset is linear in screen y. Each layer is
 * its own Sonolus effect that the engine spawns with that plane's corners
 * (nativeEffects.ts NATIVE_EFFECT_PLANES), so parallax is exact at every lane.
 * Depths are relative to the judgement line (Three z; negative = farther).
 */
export const NATIVE_EFFECT_PLANES = nativeEffects.planes;

const planeOf = (sample: QuadSample): number => sample.plane;
const majorityPlane = (samples: readonly QuadSample[]): number => {
  const counts = Array.from({ length: NATIVE_EFFECT_PLANES.length }, () => 0);
  for (const sample of samples) counts[sample.plane]! += 1;
  return counts.indexOf(Math.max(...counts));
};

/** Native effect profiles: MasterLiveQualitySettings Low loads effect001Light. */
export const NATIVE_EFFECT_PROFILES = nativeEffects.profiles.map((prefix, index) => ({
  prefix,
  quality: nativeEffects.profileQualities[index]!,
  noteEffectSkin: nativeEffects.profileSkins?.[index] ?? "effect001",
}));

/** MasterLiveQualitySettings _effectRenderingScale by quality (0 High, 2 Low). */
const EFFECT_RENDERING_SCALE: Readonly<Record<number, number>> = { 0: 1, 1: 0.85, 2: 0.71 };

type Json = Record<string, unknown>;

interface QuadParams {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

function quadParams(
  sample: QuadSample,
  expand: readonly [number, number],
  previousR?: number,
  offset: readonly [number, number] = [0, 0],
): QuadParams {
  const [c0, c1, c2, c3] = sample.corners;
  const x = (c0.x + c1.x + c2.x + c3.x) / 4;
  const y = (c0.y + c1.y + c2.y + c3.y) / 4;
  const ux = (c1.x - c0.x + (c2.x - c3.x)) / 2;
  const uy = (c1.y - c0.y + (c2.y - c3.y)) / 2;
  const vx = (c3.x - c0.x + (c2.x - c1.x)) / 2;
  const vy = (c3.y - c0.y + (c2.y - c1.y)) / 2;
  const length = Math.hypot(ux, uy);
  const cross = ux * vy - uy * vx;
  let r: number;
  let w: number;
  if (length < 1e-9) {
    r = previousR ?? 0;
    w = 0;
  } else if (cross >= 0) {
    r = Math.atan2(uy, ux);
    w = length / 2;
  } else {
    // Mirrored quad: a negative width flips the sprite horizontally only.
    r = Math.atan2(-uy, -ux);
    w = -length / 2;
  }
  if (previousR !== undefined) while (r - previousR > Math.PI) r -= 2 * Math.PI;
  if (previousR !== undefined) while (previousR - r > Math.PI) r += 2 * Math.PI;
  const h = length < 1e-9 ? Math.hypot(vx, vy) / 2 : Math.abs(cross) / length / 2;
  // A cropped tile's centre moves along the sprite's own u/v edges.
  return {
    x: x + offset[0] * ux + offset[1] * vx,
    y: y + offset[0] * uy + offset[1] * vy,
    w: w * expand[0],
    h: h * expand[1],
    r,
  };
}

const intensity = (emission: readonly number[]): number => Math.max(emission[0]!, emission[1]!, emission[2]!);

/** Tile class: texture, uv rect, emission chroma and baked bloom mips. */
function tileClass(sample: QuadSample, mips: number, mipFrom = 0): string {
  const peak = Math.max(intensity(sample.emission), 1e-9);
  // Halos keep their HDR chroma too: the clip toward white happens before any tint.
  const chroma = sample.emission
    .map((value) => Math.round((value / peak) * (mipFrom ? 4 : 8)) / (mipFrom ? 4 : 8))
    .join(",");
  return `${sample.file}|${sample.uv.map((value) => value.toFixed(4)).join(",")}|${chroma}|${mips}${mipFrom ? `h${mipFrom}` : ""}`;
}

interface TileAccumulator {
  texture: TextureKey;
  mips: number;
  mipFrom: number;
  sigmaScale: number;
  uv: QuadSample["uv"];
  emission: [number, number, number];
  heights: number[];
  aspects: number[];
}

class TileRegistry {
  /** Screen px per effect-camera px of the profile being traced. */
  sigmaScale = 1;
  readonly accumulators = new Map<string, TileAccumulator>();
  readonly tiles = new Map<string, Tile>();

  private readonly files = new Map<string, string>();

  observe(sample: QuadSample, mips: number, mipFrom = 0): string {
    const key = `${tileClass(sample, mips, mipFrom)}|s${this.sigmaScale.toFixed(2)}`;
    let acc = this.accumulators.get(key);
    if (!acc) {
      acc = {
        texture: sample.texture,
        mips,
        mipFrom,
        sigmaScale: this.sigmaScale,
        uv: sample.uv,
        emission: [0, 0, 0],
        heights: [],
        aspects: [],
      };
      this.files.set(key, sample.file);
      this.accumulators.set(key, acc);
    }
    if (intensity(sample.emission) > intensity(acc.emission)) {
      const peak = intensity(sample.emission);
      void peak;
      acc.emission = [...sample.emission] as [number, number, number];
    }
    if (sample.pixelHeight > 0.5 && sample.pixelWidth > 0.05) {
      acc.heights.push(sample.pixelHeight);
      acc.aspects.push(sample.pixelWidth / sample.pixelHeight);
    }
    return key;
  }

  bake(): void {
    // Sprites are baked for their large instances (90th percentile): small
    // ones downsample cleanly, big bright stars must not be upscaled blobs.
    const percentile = (values: number[], fallback: number, p: number) => {
      if (!values.length) return fallback;
      const sorted = values.slice().sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
    };
    for (const [key, acc] of this.accumulators) {
      this.tiles.set(
        key,
        bakeTile({
          key,
          file: this.files.get(key)!,
          uv: acc.uv,
          emission: acc.emission,
          screenHeight: percentile(acc.heights, 24, 0.9),
          screenAspect: Math.max(0.05, Math.min(20, percentile(acc.aspects, 1, 0.5))),
          sigmaScale: acc.sigmaScale,
          // 9-slice frame borders: margin on the frame's outer edges only.
          ...(acc.texture === "frame"
            ? {
                padSides: [acc.uv[0] <= 1e-6, acc.uv[2] >= 1 - 1e-6, acc.uv[1] <= 1e-6, acc.uv[3] >= 1 - 1e-6] as const,
              }
            : {}),
          ...(acc.texture === "wall" ? { maxDensity: 1 } : {}),
          mips: acc.mips,
          mipFrom: acc.mipFrom,
          bloomGain: BLOOM_GAIN,
        }),
      );
    }
  }

  chromaHex(key: string): string {
    const acc = this.accumulators.get(key)!;
    const peak = Math.max(intensity(acc.emission), 1e-9);
    return hexColor(acc.emission.map((value) => value / peak));
  }

  relative(key: string, sample: QuadSample): number {
    const acc = this.accumulators.get(key)!;
    return intensity(sample.emission) / Math.max(intensity(acc.emission), 1e-9);
  }
}

const hexColor = (rgb: readonly number[]): string =>
  `#${rgb
    .map((value) =>
      Math.round(Math.max(0, Math.min(1, value)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/** Emission-weighted chroma of a run, as a Sonolus particle color. */
const meanChroma = (samples: readonly QuadSample[]): string => {
  const total = [0, 0, 0];
  for (const sample of samples) for (let c = 0; c < 3; c += 1) total[c]! += sample.emission[c]!;
  const peak = Math.max(...total, 1e-9);
  return hexColor(total.map((value) => value / peak));
};

const round = (value: number, digits = 4): number => Math.round(value * 10 ** digits) / 10 ** digits;

/** Random-draw terms below a sub-pixel effect (units ~ 1/190 px at W4) are dropped. */
const TERM_EPSILON = 0.002;
const pruned = (expression: readonly number[]): number[] =>
  expression.map((value, index) => (index > 0 && Math.abs(value) < TERM_EPSILON ? 0 : value));

function channelJson(fit: ChannelFit): Json {
  const from = expressionJson(pruned(fit.from), 3);
  const to = expressionJson(pruned(fit.to), 3);
  if (fit.ease === "linear" && JSON.stringify(from) === JSON.stringify(to)) return { from, to: from };
  return { from, to, ease: fit.ease };
}

const CHANNELS = ["x", "y", "w", "h", "r", "a"] as const;
type Channel = (typeof CHANNELS)[number];

interface ChannelObservations {
  x: Observation[];
  y: Observation[];
  w: Observation[];
  h: Observation[];
  r: Observation[];
  a: Observation[];
}

const emptyObservations = (): ChannelObservations => ({ x: [], y: [], w: [], h: [], r: [], a: [] });

/** Random draws that explain a channel's per-instance variance (residual after the time mean). */
function screenFeatures(observations: readonly Observation[], candidates: readonly number[]): number[] {
  if (!candidates.length || observations.length < 8) return [];
  const bins = new Map<number, { sum: number; count: number }>();
  for (const observation of observations) {
    const bin = Math.round(observation.q * 20);
    const entry = bins.get(bin) ?? { sum: 0, count: 0 };
    entry.sum += observation.v;
    entry.count += 1;
    bins.set(bin, entry);
  }
  const residual = observations.map((observation) => {
    const entry = bins.get(Math.round(observation.q * 20))!;
    return observation.v - entry.sum / entry.count;
  });
  const variance = residual.reduce((sum, value) => sum + value * value, 0) / residual.length;
  if (variance < 1e-8) return [];
  const scores = candidates.map((feature) => {
    let sxy = 0;
    let sxx = 0;
    observations.forEach((observation, index) => {
      const x = observation.r[feature]! - 0.5;
      sxy += x * residual[index]!;
      sxx += x * x;
    });
    return { feature, score: (sxy * sxy) / Math.max(sxx, 1e-12) / (variance * residual.length) };
  });
  return scores
    .filter((entry) => entry.score > 0.02)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FEATURES)
    .map((entry) => entry.feature);
}

function fitPieces(
  build: (q0: number, q1: number) => ChannelObservations,
  random: boolean,
  maxPieces: number,
): Array<{ q0: number; q1: number; fits: Record<Channel, ChannelFit> }> {
  const fitRange = (q0: number, q1: number) => {
    const observations = build(q0, q1);
    const fits = {} as Record<Channel, ChannelFit>;
    let worst = 0;
    for (const channel of CHANNELS) {
      const list = observations[channel];
      if (!list.length) {
        fits[channel] = {
          from: [0, 0, 0, 0, 0, 0, 0, 0, 0],
          to: [0, 0, 0, 0, 0, 0, 0, 0, 0],
          ease: "linear",
          rms: 0,
          max: 0,
        };
        continue;
      }
      const channelFeatures = random ? screenFeatures(list, CHANNEL_DRAWS[channel]) : [];
      let fit: ChannelFit;
      if (channel === "w" || channel === "h") {
        // Sizes keep one sign per trajectory (negative width = mirrored);
        // fit the magnitude so the random terms can never flip or explode it.
        const sign = list.reduce((sum, observation) => sum + observation.v, 0) < 0 ? -1 : 1;
        const magnitude = list.map((observation) => ({ ...observation, v: Math.abs(observation.v) }));
        const ceiling = Math.max(...magnitude.map((observation) => observation.v)) * 1.1;
        fit = capToCeiling(
          raiseToFloor(fitChannel(magnitude, channelFeatures, random ? COHORT_EASES : undefined), 0),
          ceiling,
        );
        if (sign < 0) fit = { ...fit, from: fit.from.map((value) => -value), to: fit.to.map((value) => -value) };
      } else {
        fit = fitChannel(list, channelFeatures, random ? COHORT_EASES : undefined);
        if (channel === "a") fit = capToCeiling(raiseToFloor(fit, 0), 1);
      }
      fits[channel] = fit;
      const tolerance = channel === "a" ? ALPHA_TOLERANCE : channel === "r" ? 0.08 : POSITION_TOLERANCE;
      worst = Math.max(worst, fit.rms / tolerance);
    }
    return { fits, worst };
  };
  // Greedy bisection of the worst piece until every channel is within tolerance.
  let pieces = [{ q0: 0, q1: 1, ...fitRange(0, 1) }];
  while (pieces.length < maxPieces) {
    const worstIndex = pieces.reduce((best, piece, index) => (piece.worst > pieces[best]!.worst ? index : best), 0);
    const worst = pieces[worstIndex]!;
    if (worst.worst <= 1 || worst.q1 - worst.q0 < 0.02) break;
    // Split where the alpha observations change fastest (fade-in/out edges).
    const mid = (worst.q0 + worst.q1) / 2;
    const left = { q0: worst.q0, q1: mid, ...fitRange(worst.q0, mid) };
    const right = { q0: mid, q1: worst.q1, ...fitRange(mid, worst.q1) };
    pieces.splice(worstIndex, 1, left, right);
  }
  return pieces.map(({ q0, q1, fits }) => ({ q0, q1, fits }));
}

function particleDefs(
  sprite: number,
  start: number,
  duration: number,
  pieces: ReturnType<typeof fitPieces>,
  color = "#ffffff",
): Json[] {
  return pieces.map((piece) => ({
    sprite,
    color,
    start: round(start + piece.q0 * duration),
    duration: round((piece.q1 - piece.q0) * duration),
    x: channelJson(piece.fits.x),
    y: channelJson(piece.fits.y),
    w: channelJson(piece.fits.w),
    h: channelJson(piece.fits.h),
    r: channelJson(piece.fits.r),
    a: channelJson(piece.fits.a),
  }));
}

/**
 * Rig quads with under 0.5% of their family's light (the wall's 3 px bevel
 * slivers) are left to the composite halo: as parallelograms they only
 * render as stray lines.
 */
/**
 * The original adds overlapping stars in HDR, so dense clusters saturate to
 * white; Sonolus alpha-composites and a cluster never exceeds its sprite's
 * colour. Each system's sprite is therefore baked at its measured mean local
 * overlap (particles per 8 px cell, weighted by particle), capped at
 * MAX_OVERLAP_GAIN.
 */
const MAX_OVERLAP_GAIN = Number(process.env.SONOLUS_OVERLAP_GAIN ?? 6);
function withOverlapGain(particles: readonly ParticleSample[], width: number): ParticleSample[] {
  if (MAX_OVERLAP_GAIN <= 1) return particles.slice();
  const units = unitsPerPixel(width / 4);
  const cells = new Map<string, number>();
  for (const sample of particles) {
    if (intensity(sample.emission) <= 1e-3) continue;
    const cx = sample.corners.reduce((sum, corner) => sum + corner.x, 0) / 4;
    const cy = sample.corners.reduce((sum, corner) => sum + corner.y, 0) / 4;
    const key = `${sample.system}|${sample.seed}|${sample.t.toFixed(4)}|${Math.round(cx / (8 * units.x))}|${Math.round(cy / (8 * units.y))}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  const bySystem = new Map<number, { weighted: number; count: number }>();
  for (const [key, count] of cells) {
    const system = Number(key.split("|")[0]);
    const entry = bySystem.get(system) ?? { weighted: 0, count: 0 };
    entry.weighted += count * count;
    entry.count += count;
    bySystem.set(system, entry);
  }
  const gains = new Map<number, number>();
  for (const [system, { weighted, count }] of bySystem)
    gains.set(system, Math.max(1, Math.min(MAX_OVERLAP_GAIN, weighted / Math.max(1, count))));
  return particles.map((sample) => {
    const gain = gains.get(sample.system) ?? 1;
    return gain === 1
      ? sample
      : { ...sample, emission: sample.emission.map((value) => value * gain) as unknown as typeof sample.emission };
  });
}

/**
 * Size-over-lifetime flicker (Light ef_particle_point: ~12 pulses per life)
 * has a per-instance phase set by the random lifetime, which a Sonolus def
 * cannot express. Use the star's RMS size over one pulse and keep its
 * energy (area x brightness); it glows steadily instead of twinkling.
 */
function flickerEnvelope(list: readonly ParticleSample[]): ParticleSample[] {
  const sizes = list.map((sample) => Math.sqrt(sample.pixelArea));
  let turns = 0;
  for (let index = 2; index < sizes.length; index += 1) {
    const a = sizes[index - 1]! - sizes[index - 2]!;
    const b = sizes[index]! - sizes[index - 1]!;
    if (a * b < 0 && Math.abs(a) + Math.abs(b) > 0.2 * Math.max(...sizes)) turns += 1;
  }
  if (turns < 4 || list.length < 5) return list.slice();
  const window = Math.max(1, Math.round(list.length / Math.max(1, turns / 2) / 2));
  return list.map((sample, index) => {
    let peak = 0;
    let energy = 0;
    let count = 0;
    let peakSample = sample;
    for (let j = Math.max(0, index - window); j <= Math.min(list.length - 1, index + window); j += 1) {
      const other = list[j]!;
      energy += other.pixelArea * intensity(other.emission);
      count += 1;
      if (sizes[j]! > peak) {
        peak = sizes[j]!;
        peakSample = other;
      }
    }
    if (peak <= 0) return sample;
    // RMS-sized quad centred on this sample, brightness = window energy / area.
    let areaSum = 0;
    for (let j = Math.max(0, index - window); j <= Math.min(list.length - 1, index + window); j += 1)
      areaSum += list[j]!.pixelArea;
    const rms = Math.sqrt(areaSum / count);
    const scale = rms / Math.max(1e-9, sizes[index]!);
    const cx = sample.corners.reduce((sum, corner) => sum + corner.x, 0) / 4;
    const cy = sample.corners.reduce((sum, corner) => sum + corner.y, 0) / 4;
    const px = peakSample.corners.reduce((sum, corner) => sum + corner.x, 0) / 4;
    const py = peakSample.corners.reduce((sum, corner) => sum + corner.y, 0) / 4;
    const corners = (sizes[index]! > 1e-6 ? sample : peakSample).corners.map((corner) => ({
      x: cx + (corner.x - (sizes[index]! > 1e-6 ? cx : px)) * (sizes[index]! > 1e-6 ? scale : rms / peak),
      y: cy + (corner.y - (sizes[index]! > 1e-6 ? cy : py)) * (sizes[index]! > 1e-6 ? scale : rms / peak),
    })) as unknown as QuadSample["corners"];
    const area = Math.max(1e-9, rms * rms);
    const brightness = energy / count / area;
    const factor = brightness / Math.max(1e-9, intensity(peakSample.emission));
    return {
      ...sample,
      corners,
      pixelArea: area,
      pixelWidth: peakSample.pixelWidth * (rms / peak),
      pixelHeight: peakSample.pixelHeight * (rms / peak),
      emission: peakSample.emission.map((value) => value * factor) as unknown as QuadSample["emission"],
    };
  });
}

/**
 * Large star systems (ef_particle_star: startSize 0.1..0.6 x2, median ~40 px)
 * only read right as additive HDR blooms; alpha-composited they become big
 * translucent teardrops, so they are left out. Small stars and the flick
 * streaks (longStar) stay.
 */
const LARGE_STAR_PX = Number(process.env.SONOLUS_LARGE_STAR_PX ?? 25);
function dropLargeStars(particles: readonly ParticleSample[]): ParticleSample[] {
  const heights = new Map<number, number[]>();
  for (const sample of particles) {
    if (sample.texture !== "star") continue;
    let list = heights.get(sample.system);
    if (!list) heights.set(sample.system, (list = []));
    list.push(sample.pixelHeight);
  }
  const large = new Set<number>();
  for (const [system, list] of heights) {
    list.sort((a, b) => a - b);
    if (list[Math.floor(list.length / 2)]! > LARGE_STAR_PX) large.add(system);
  }
  return particles.filter((sample) => !large.has(sample.system));
}

/**
 * Overlapping stars add up in the original's HDR target and clip to white;
 * Sonolus composites them. Baking the star sprites brighter (more of each
 * star clips to white, its glow grows) stands in for that accumulation.
 */
const STAR_GLOW = process.env.SONOLUS_STAR_GLOW === "1";
const STAR_HDR_BOOST = Number(process.env.SONOLUS_STAR_HDR_BOOST ?? 3);
function hdrBoost(particles: readonly ParticleSample[]): ParticleSample[] {
  if (STAR_HDR_BOOST === 1) return particles.slice();
  return particles.map((sample) => ({
    ...sample,
    emission: sample.emission.map((value) => value * STAR_HDR_BOOST) as unknown as typeof sample.emission,
  }));
}

/** Family (frame, wall, pillarNN) of a traced mesh trajectory. */
const familyOf = new WeakMap<readonly QuadSample[], string>();

function significantMeshes(
  meshes: ReadonlyMap<string, readonly QuadSample[]>,
  select: (list: readonly QuadSample[]) => readonly QuadSample[],
): Array<readonly QuadSample[]> {
  const energy = (list: readonly QuadSample[]) =>
    Math.max(0, ...list.map((sample) => intensity(sample.emission) * sample.pixelArea));
  const familyPeak = new Map<string, number>();
  for (const [key, list] of meshes) {
    const family = key.split("#")[0]!;
    familyPeak.set(family, Math.max(familyPeak.get(family) ?? 0, energy(list)));
  }
  return [...meshes.entries()]
    .filter(([key]) => key.split("#")[0] !== "wall")
    .filter(([key, list]) => energy(list) >= 0.005 * (familyPeak.get(key.split("#")[0]!) ?? 0))
    .map(([key, list]) => {
      const trimmed = select(list);
      familyOf.set(trimmed, key.split("#")[0]!);
      return trimmed;
    });
}

/** Split one deterministic trajectory into runs of one tile class. */
function runsOf(
  samples: readonly QuadSample[],
  registry: TileRegistry,
  mips: number,
  mipFrom = 0,
): Array<{ key: string; samples: QuadSample[] }> {
  const runs: Array<{ key: string; samples: QuadSample[] }> = [];
  for (const sample of samples) {
    if (intensity(sample.emission) <= 1e-6) {
      runs.push({ key: "", samples: [] });
      continue;
    }
    const key = registry.observe(sample, mips, mipFrom);
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.samples.push(sample);
    else runs.push({ key, samples: [sample] });
  }
  return runs.filter((run) => run.key && run.samples.length >= 1);
}

interface PendingGroup {
  /** Plane layer (NATIVE_EFFECT_PLANES index). */
  plane: number;
  build(sprites: ReadonlyMap<string, number>): Json | undefined;
}

/** SONOLUS_PARTICLE_DEBUG=1 tags groups with their tile class (probe output only). */
const debugTag = (key: string): Json => (process.env.SONOLUS_PARTICLE_DEBUG ? { debug: key.split("/").pop() } : {});

const GLOW_KEY = "glow";
/**
 * Rig bloom layers rendered from the real geometry: the sharp mips (0..2) at
 * a third of the screen density, the wide ones (3..4) at an eighth.
 */
const SLICED_FAMILIES = new Set(["wall", "frame"]);
/** Screen px beyond the padding that stay unstretched at each end (side faces, 9-slice borders). */
const SLICE_END_MARGIN = 48;

const COMPOSITE_LAYERS = [
  // The wall mesh (front, sides, bevels) as one additive image: its faces
  // overlap, and layered Sonolus sprites would darken each other.
  { label: "far", mipFrom: 3, mipTo: 5, density: 1 / 10, families: "all" },
  { label: "near", mipFrom: 1, mipTo: 3, density: 1 / 4, families: "all" },
  { label: "core", mipFrom: 0, mipTo: 1, density: 1 / 2, families: "wall", core: true },
] as const;
const RIG_GLOW_KEY = "rig-glow";
/** Screen cell (1080p px) of the far-bloom grid; the default gives one glow per effect. */
const GLOW_CELL = Number(process.env.SONOLUS_PARTICLE_GLOW_CELL ?? "100000");
const GLOW_VISIBILITY = 0.05;
const HALO_KEY = "halo";

export interface CompileResult {
  effects: Json[];
  atlas: ReturnType<typeof packAtlas>;
  report: Array<{ name: string; groups: number; defs: number }>;
}

export async function compileNativeParticles(options: {
  releaseRoot: string;
  profiles?: ReadonlyArray<{
    prefix: string;
    quality: number;
    noteEffectSkin?: "effect001" | "effect001Simple";
  }>;
  log?: (line: string) => void;
  /** Diagnostics: only trace effects whose name passes. */
  only?: (name: string) => boolean;
}): Promise<CompileResult> {
  const log = options.log ?? (() => {});
  const profiles = options.profiles ?? NATIVE_EFFECT_PROFILES;
  const tracers = await Promise.all(
    profiles.map(async (profile) => {
      const tracer = new EffectTracer({
        releaseRoot: options.releaseRoot,
        currentQuality: profile.quality,
        ...(profile.noteEffectSkin ? { noteEffectSkin: profile.noteEffectSkin } : {}),
      });
      await tracer.load();
      return { profile, tracer };
    }),
  );
  let tracer = tracers[0]!.tracer;
  const registry = new TileRegistry();
  const compositeHalos = new Map<string, ReturnType<typeof bakeCompositeHalo>>();
  /** Cut a baked composite into its left end, one-column middle and right end. */
  const slicedComposites = new Map<string, Tile>();
  const sliceTiles = (key: string, baked: ReturnType<typeof bakeCompositeHalo>, endWidth: number): void => {
    if (slicedComposites.has(`${key}|L`)) return;
    const { width, height, pixels } = baked.tile.image;
    const endColumns = Math.max(
      1,
      Math.min(Math.floor(width / 2) - 1, Math.round((endWidth / (baked.rect.x1 - baked.rect.x0)) * width)),
    );
    const cut = (from: number, to: number, suffix: string) => {
      const columns = to - from;
      const out = new Uint8Array(columns * height * 4);
      for (let y = 0; y < height; y += 1)
        out.set(pixels.subarray((y * width + from) * 4, (y * width + to) * 4), y * columns * 4);
      slicedComposites.set(`${key}|${suffix}`, {
        ...baked.tile,
        key: `${key}|${suffix}`,
        image: { width: columns, height, pixels: out },
      });
    };
    cut(0, endColumns, "L");
    const middle = Math.floor(width / 2);
    cut(middle, middle + 1, "M");
    cut(width - endColumns, width, "R");
  };
  /** Particle glow kernels by profile bloom scale. */
  const glowKernels = new Map<string, BloomKernel>();
  const glowKernelFor = (scale: number): { key: string; kernel: BloomKernel } => {
    const key = `${GLOW_KEY}|${scale.toFixed(2)}`;
    let kernel = glowKernels.get(key);
    if (!kernel) glowKernels.set(key, (kernel = bloomKernel(STAR_HALOS ? STAR_HALO_MIPS : 1, 5, scale)));
    return { key, kernel };
  };
  const pending: Array<{ name: string; groups: PendingGroup[]; layered: boolean }> = [];
  let bloomScale = 1;
  for (const entry of tracers) {
    tracer = entry.tracer;
    bloomScale = 1 / (EFFECT_RENDERING_SCALE[entry.profile.quality] ?? 1);
    registry.sigmaScale = bloomScale;
    await traceProfile(entry.profile.prefix);
  }
  if (process.env.SONOLUS_PARTICLE_TILE_REPORT) {
    const counts = new Map<string, number>();
    for (const key of registry.accumulators.keys()) {
      const name = key.split("|")[0]!.split("/").pop()!;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    log(`tile classes ${JSON.stringify(Object.fromEntries(counts))}`);
  }
  registry.bake();
  const tiles = [
    ...registry.tiles.values(),
    ...[...compositeHalos.values()]
      .filter((entry) => !slicedComposites.has(`${entry.tile.key}|L`))
      .map((entry) => entry.tile),
    ...slicedComposites.values(),
    ...[...glowKernels.entries()].map(([key, kernel]) => bakeKernelTile(key, kernel)),
    bakeKernelTile(HALO_KEY, HALO_KERNEL),
  ];
  const atlas = packAtlas(tiles);
  log(`baked ${tiles.length} tiles into ${atlas.width}x${atlas.height}`);
  // Pass 2: fit with the baked tile expansion/response.
  const effects: Json[] = [];
  const report: CompileResult["report"] = [];
  const identity = Object.fromEntries(
    ["x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"].map((key) => [key, { [key]: 1 }]),
  );
  for (const entry of pending) {
    // Lane effects keep one layer; hits and the hold loop get every plane.
    const layers = entry.layered ? NATIVE_EFFECT_PLANES.length : 1;
    for (let plane = 0; plane < layers; plane += 1) {
      const groups = entry.groups
        .filter((group) => !entry.layered || group.plane === plane)
        .map((group) => group.build(atlas.index))
        .filter((group): group is Json => !!group);
      const name = entry.layered ? `${entry.name} ${NATIVE_EFFECT_PLANES[plane]!.label}` : entry.name;
      effects.push({ name, transform: identity, groups });
      report.push({
        name,
        groups: groups.length,
        defs: groups.reduce((total, group) => total + (group.particles as unknown[]).length, 0),
      });
    }
  }
  return { effects, atlas, report };

  async function traceProfile(prefix: string): Promise<void> {
    const specs: EffectSpec[] = [];
    for (const kind of NOTE_KINDS)
      for (const judgement of JUDGEMENTS)
        specs.push({
          name: `${prefix} ${kind.label}${judgement.suffix}`,
          kind: kind.kind,
          direction: kind.direction,
          judgement: judgement.judgement,
          lifetime: nativeParticleEffectLifetime(kind.kind, judgement.native),
        });
    const loopPeriod = await tracer.clipDuration(tracer.assets.particles.effect001Prefabs.SlideLoop!.animationClipUrl);
    specs.push({
      name: `${prefix} Slide Loop`,
      kind: "slide-loop",
      direction: "none",
      judgement: "perfect",
      lifetime: loopPeriod,
      loop: { period: loopPeriod },
    });
    if (prefix === profiles[0]!.prefix)
      for (const kind of LANE_KINDS)
        specs.push({
          name: `Our Notes Lane ${kind.label}`,
          kind: kind.kind,
          direction: "none",
          judgement: "perfect",
          lifetime: 0.45 / 2,
          lane: true,
        });

    // Pass 1: trace everything and register tile classes.
    for (const spec of specs) {
      for (const width of spec.lane ? [2] : NATIVE_EFFECT_WIDTHS) {
        const name = spec.lane ? spec.name : nativeEffectName(spec.name, width);
        if (options.only && !options.only(name)) continue;
        const warm = spec.loop ? spec.loop.period * 3 : 0;
        const times: number[] = [];
        const span = spec.loop ? spec.loop.period * 2 : spec.lifetime;
        for (let t = 0; t <= span + 1e-9; t += SAMPLE_STEP) times.push(warm + t);
        const groups: PendingGroup[] = [];
        const progressOf = (t: number) => (t - warm) / spec.lifetime;
        if (spec.lane) {
          const samples = tracer.traceLane(spec.kind, width, times);
          groups.push(...deterministicGroups([samples], registry, progressOf, spec));
        } else {
          const trace = tracer.trace(
            {
              kind: spec.kind,
              direction: spec.direction,
              judgement: spec.judgement,
              lifetime: spec.loop ? undefined : spec.lifetime,
            } as never,
            width,
            times,
            spec.loop ? SEEDS.slice(0, 1) : SEEDS,
          );
          const oneCycle = (list: readonly QuadSample[]) => list.filter((sample) => progressOf(sample.t) <= 1 + 1e-9);
          // Halos first: groups draw in order and the sharp cores go on top.
          groups.push(...compositeHaloGroups(trace.meshes, width, progressOf, spec));
          groups.push(...deterministicGroups(significantMeshes(trace.meshes, oneCycle), registry, progressOf, spec));
          // Off by default: measured worse than none (see SWARM_VISIBILITY).
          if (!spec.loop && Number.isFinite(SWARM_VISIBILITY))
            groups.unshift(...swarmBloomGroups(trace.particles, width, progressOf, spec, SEEDS.length));
          const stars = hdrBoost(dropLargeStars(trace.particles));
          groups.push(...cohortGroups(withOverlapGain(stars, width), registry, progressOf, spec, warm, width));
          const seedCount = spec.loop ? 1 : SEEDS.length;
          groups.unshift(
            // Star cloud glow (a flux-centroid blob) is off by default: with the large
            // stars removed it only showed as stray blobs.
            ...(STAR_GLOW
              ? glowGroups([], trace.particles, width, progressOf, spec, seedCount, glowKernelFor(bloomScale))
              : []),
          );
        }
        // The hold loop gets the same plane layers as a hit (the engine moves
        // all four instances with nativeEffectPlaneLayout).
        pending.push({ name, groups, layered: !spec.lane });
        log(`traced ${name}: ${groups.length} groups`);
      }
    }
  }

  function deterministicGroups(
    trajectories: ReadonlyArray<readonly QuadSample[]>,
    tiles: TileRegistry,
    progressOf: (t: number) => number,
    spec: EffectSpec,
  ): PendingGroup[] {
    const groups: PendingGroup[] = [];
    for (const trajectory of trajectories) {
      const family = trajectory[0] ? familyOf.get(trajectory) : undefined;
      void family;
      const runs = runsOf(trajectory, tiles, spec.lane ? 0 : RIG_BLOOM_MIPS);
      for (const run of runs) {
        groups.push({
          plane: planeOf(run.samples[Math.floor(run.samples.length / 2)]!),
          build: (sprites) => {
            const tile = tiles.tiles.get(run.key)!;
            const sprite = sprites.get(run.key)!;
            const p0 = progressOf(run.samples[0]!.t);
            const p1 = progressOf(run.samples[run.samples.length - 1]!.t);
            // Sampling lands on Animator activation edges (1/30 s); open the
            // run half a step early and hold the last sample for one step.
            const start = Math.max(0, p0 - SAMPLE_STEP / 2 / spec.lifetime);
            const end = Math.min(spec.loop ? 2 : 1, Math.max(p1, p0) + SAMPLE_STEP / spec.lifetime);
            const duration = Math.max(1e-4, end - start);
            let previousR: number | undefined;
            const params = run.samples.map((sample) => {
              const quad = quadParams(sample, tile.expand, previousR, tile.offset);
              previousR = quad.r;
              return {
                q: (progressOf(sample.t) - start) / duration,
                quad,
                a: responseAt(tile, tiles.relative(run.key, sample)),
              };
            });
            const build = (q0: number, q1: number): ChannelObservations => {
              const observations = emptyObservations();
              const span = Math.max(1e-9, q1 - q0);
              for (const { q, quad, a } of params) {
                if (q < q0 - 1e-9 || q > q1 + 1e-9) continue;
                const local = (q - q0) / span;
                for (const channel of ["x", "y", "w", "h", "r"] as const)
                  observations[channel].push({ q: local, r: [], v: quad[channel] });
                observations.a.push({ q: local, r: [], v: a });
              }
              return observations;
            };
            const pieces = fitPieces(build, false, MAX_MESH_PIECES);
            const halo = run.key.endsWith("h1");
            const chroma = halo ? meanChroma(run.samples) : "#ffffff";
            return { count: 1, particles: particleDefs(sprite, start, duration, pieces, chroma), ...debugTag(run.key) };
          },
        });
      }
    }
    return groups;
  }

  function cohortGroups(
    particles: readonly ParticleSample[],
    tiles: TileRegistry,
    progressOf: (t: number) => number,
    spec: EffectSpec,
    warm: number,
    width: number,
  ): PendingGroup[] {
    const bySlot = new Map<string, Map<number, ParticleSample[]>>();
    for (const sample of particles) {
      if (intensity(sample.emission) <= 1e-6) continue;
      const slot = `${sample.system}:${sample.emission_}`;
      let seeds = bySlot.get(slot);
      if (!seeds) bySlot.set(slot, (seeds = new Map()));
      let list = seeds.get(sample.seed);
      if (!list) seeds.set(sample.seed, (list = []));
      list.push(sample);
    }
    // Loops keep only particles born inside the authored cycle; Sonolus wraps
    // their tails into the next cycle.
    const slots = [...bySlot.entries()]
      .map(([slot, seeds]) => {
        const births = [...seeds.values()].map((list) => list[0]!.birth);
        return { system: Number(slot.split(":")[0]), seeds, birth: births.reduce((a, b) => a + b, 0) / births.length };
      })
      .filter((slot) => !spec.loop || (slot.birth >= warm - 1e-9 && slot.birth < warm + spec.loop.period));
    const bySystem = new Map<number, typeof slots>();
    for (const slot of slots) {
      let list = bySystem.get(slot.system);
      if (!list) bySystem.set(slot.system, (list = []));
      list.push(slot);
    }
    const units = unitsPerPixel(width / 4);
    const groups: PendingGroup[] = [];
    for (const systemSlots of bySystem.values()) {
      systemSlots.sort((a, b) => a.birth - b.birth);
      // Emission times are deterministic per slot; only the draws vary. A
      // Sonolus instance cannot know its slot, so a group may only hold slots
      // born together (within BIRTH_WINDOW): then every trajectory is a
      // function of the random draws alone.
      const cohorts: Array<typeof systemSlots> = [];
      for (const slot of systemSlots) {
        const last = cohorts[cohorts.length - 1];
        if (last && last.length < COHORT_SIZE && slot.birth - last[0]!.birth <= BIRTH_WINDOW) last.push(slot);
        else cohorts.push([slot]);
      }
      for (const cohort of cohorts) {
        const instances = cohort.flatMap((slot) => [...slot.seeds.values()]);
        const lifetimes = instances.map((list) => list[0]!.lifetime);
        const shortest = Math.min(...lifetimes);
        const longest = Math.max(...lifetimes);
        // Random lifetimes cannot share one fade-out edge: split the lifetime
        // draw (r4) into bins, each re-mapped onto the full [0, 1) range.
        // Random lifetimes cannot share one fade-out edge or one decelerating
        // path: bin the lifetime draw (r4) so each bin's spread stays under
        // LIFETIME_SPREAD of its lifetime.
        const bins = Math.min(
          MAX_LIFETIME_BINS,
          Math.max(1, Math.ceil((longest - shortest) / Math.max(1e-6, LIFETIME_SPREAD * longest))),
        );
        // Path = velocity draw (5) x curve(age / lifetime): a product Sonolus
        // expressions cannot hold. Splitting both draws makes it near-linear
        // inside each bin (each bin re-mapped onto [0, 1)).
        const velocityBins = VELOCITY_BINS;
        for (let cell = 0; cell < bins * velocityBins; cell += 1) {
          const bin = Math.floor(cell / velocityBins);
          const vbin = cell % velocityBins;
          const lo = bin / bins;
          const hi = (bin + 1) / bins;
          const vlo = vbin / velocityBins;
          const vhi = (vbin + 1) / velocityBins;
          const members = instances.filter(
            (list) =>
              (bins === 1 || (list[0]!.draws[3]! >= lo && list[0]!.draws[3]! < hi)) &&
              (velocityBins === 1 || (list[0]!.draws[5]! >= vlo && list[0]!.draws[5]! < vhi)),
          );
          if (!members.length) continue;
          const cells = bins * velocityBins;
          const count = Math.round((cohort.length * (cell + 1)) / cells) - Math.round((cohort.length * cell) / cells);
          if (count <= 0) continue;
          const remap = (draws: readonly number[]): number[] => {
            const copy = draws.slice();
            if (bins > 1) copy[3] = (copy[3]! - lo) / (hi - lo);
            if (velocityBins > 1) copy[5] = (copy[5]! - vlo) / (vhi - vlo);
            return copy;
          };
          const samples = members.flat();
          const classWeight = new Map<string, number>();
          for (const sample of samples) {
            const key = tiles.observe(sample, SPRITE_BLOOM_MIPS);
            classWeight.set(key, (classWeight.get(key) ?? 0) + intensity(sample.emission));
          }
          const key = [...classWeight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
          if (!key) continue;
          // The star's own near bloom (mips 1..2): a halo-only bake of the same
          // sprite that follows its position, size and rotation.
          const haloClass = new Map<string, number>();
          for (const sample of samples) {
            const haloKey = tiles.observe(sample, STAR_HALO_MIPS, 1);
            haloClass.set(haloKey, (haloClass.get(haloKey) ?? 0) + intensity(sample.emission));
          }
          const haloKey = [...haloClass.entries()].sort((a, b) => b[1] - a[1])[0]![0];
          groups.push({
            plane: majorityPlane(samples),
            build: (sprites) => {
              const tile = tiles.tiles.get(key)!;
              const sprite = sprites.get(key)!;
              const haloTile = tiles.tiles.get(haloKey)!;
              const halo = sprites.get(haloKey)!;
              const start = Math.max(0, progressOf(Math.min(...samples.map((sample) => sample.t))));
              const endProgress =
                progressOf(Math.max(...samples.map((sample) => sample.t))) + SAMPLE_STEP / spec.lifetime;
              const end = Math.min(spec.loop ? 2 : 1, endProgress);
              const duration = Math.max(1e-4, end - start);
              const traced = members.map((raw) => {
                let previousR: number | undefined;
                const draws = remap(raw[0]!.draws);
                const list = flickerEnvelope(raw);
                return list.map((sample) => {
                  const quad = quadParams(sample, tile.expand, previousR, tile.offset);
                  previousR = quad.r;
                  const haloQuad = quadParams(sample, haloTile.expand, quad.r, haloTile.offset);
                  return {
                    q: (progressOf(sample.t) - start) / duration,
                    quad,
                    a: responseAt(tile, tiles.relative(key, sample)),
                    haloQuad,
                    haloA: responseAt(haloTile, tiles.relative(haloKey, sample)),
                    draws,
                  };
                });
              });
              const gridStep = SAMPLE_STEP / (spec.lifetime * duration);
              const observe =
                (useHalo: boolean) =>
                (q0: number, q1: number): ChannelObservations => {
                  const observations = emptyObservations();
                  const span = Math.max(1e-9, q1 - q0);
                  for (const instance of traced) {
                    const draws = instance[0]!.draws;
                    const first = instance[0]!.q;
                    const last = instance[instance.length - 1]!.q;
                    for (const { q, quad: core, a, haloQuad, haloA } of instance) {
                      if (q < q0 - 1e-9 || q > q1 + 1e-9) continue;
                      const local = (q - q0) / span;
                      const quad = useHalo ? haloQuad : core;
                      observations.x.push({ q: local, r: draws, v: quad.x });
                      observations.y.push({ q: local, r: draws, v: quad.y });
                      observations.w.push({ q: local, r: draws, v: quad.w });
                      observations.h.push({ q: local, r: draws, v: quad.h });
                      observations.r.push({ q: local, r: draws, v: quad.r });
                      observations.a.push({ q: local, r: draws, v: useHalo ? haloA : a });
                    }
                    // Before birth and after death the instance is invisible.
                    for (let q = q0; q <= q1 + 1e-9; q += gridStep) {
                      if (q >= first - gridStep / 2 && q <= last + gridStep / 2) continue;
                      observations.a.push({ q: (q - q0) / span, r: draws, v: 0 });
                    }
                  }
                  return observations;
                };
              const spritePieces = fitPieces(observe(false), true, MAX_COHORT_PIECES);
              if (process.env.SONOLUS_FIT_REPORT) {
                const obs = observe(false)(0, 1);
                const mean = (channel: Channel) =>
                  obs[channel].reduce((sum, o) => sum + Math.abs(o.v), 0) / Math.max(1, obs[channel].length);
                const piece = spritePieces.reduce((worst, candidate) =>
                  candidate.fits.y.rms > worst.fits.y.rms ? candidate : worst,
                ).fits;
                const pieceCount = spritePieces.length;
                // Bias: mean fitted / mean observed per channel over all pieces.
                const bias = (channel: Channel) => {
                  let fitted = 0;
                  let observed = 0;
                  for (const piece of spritePieces) {
                    const span = piece.q1 - piece.q0;
                    for (const o of observe(false)(piece.q0, piece.q1)[channel]) {
                      const fit = piece.fits[channel];
                      const value = (expression: readonly number[]) =>
                        expression.reduce(
                          (sum, coefficient, index) => sum + coefficient * (index === 0 ? 1 : o.r[index - 1]!),
                          0,
                        );
                      const k = ease(fit.ease, o.q);
                      fitted += Math.abs(value(fit.from) + (value(fit.to) - value(fit.from)) * k);
                      observed += Math.abs(o.v);
                      void span;
                    }
                  }
                  return fitted / Math.max(1e-9, observed);
                };
                fitReport.push(`BIAS w=${bias("w").toFixed(2)} h=${bias("h").toFixed(2)} a=${bias("a").toFixed(2)}`);
                fitReport.push(
                  `${key.split("|")[0]!.split("/").pop()} n=${members.length} pieces=${pieceCount} ` +
                    (["x", "y", "w", "h", "a"] as const)
                      .map(
                        (channel) =>
                          `${channel}:${(piece[channel].rms / Math.max(1e-6, channel === "x" || channel === "y" ? units.x * 20 : mean(channel))).toFixed(2)}`,
                      )
                      .join(" "),
                );
              }
              const haloPieces = STAR_HALOS ? fitPieces(observe(true), true, MAX_COHORT_PIECES) : [];
              return {
                count,
                ...debugTag(key),
                particles: [
                  ...particleDefs(halo, start, duration, haloPieces),
                  ...particleDefs(sprite, start, duration, spritePieces),
                ],
              };
            },
          });
        }
      }
    }
    return groups;
  }

  /**
   * HDR accumulation of dense star swarms: the original adds overlapping
   * stars before bloom, so a flick column clips to white and blooms as one
   * cloud; alpha-composited sprites cannot add up. The bloom of a random cloud
   * equals (to within the blur radius) the bloom of its mean density, which
   * is deterministic: bake it from every traced seed at SWARM_KEYFRAMES times
   * and cross-fade them. Only swarms whose cloud is visible get one.
   */
  function swarmBloomGroups(
    particles: readonly ParticleSample[],
    width: number,
    progressOf: (t: number) => number,
    spec: EffectSpec,
    seedCount: number,
  ): PendingGroup[] {
    const units = unitsPerPixel(width / 4);
    const byTime = new Map<number, ParticleSample[]>();
    for (const sample of particles) {
      if (intensity(sample.emission) <= 1e-3) continue;
      const step = Math.round(sample.t / SAMPLE_STEP);
      let list = byTime.get(step);
      if (!list) byTime.set(step, (list = []));
      list.push(sample);
    }
    const steps = [...byTime.keys()].sort((a, b) => a - b);
    if (!steps.length) return [];
    const energy = (list: readonly ParticleSample[]) =>
      list.reduce((sum, sample) => sum + intensity(sample.emission) * sample.pixelArea, 0) / seedCount;
    const energies = steps.map((step) => energy(byTime.get(step)!));
    const total = energies.reduce((a, b) => a + b, 0);
    if (total <= 0) return [];
    // Keyframes at energy quantiles.
    const keys: number[] = [];
    let running = 0;
    let next = 0;
    for (let index = 0; index < steps.length && keys.length < SWARM_KEYFRAMES; index += 1) {
      running += energies[index]!;
      while (keys.length < SWARM_KEYFRAMES && running >= ((next + 0.5) / SWARM_KEYFRAMES) * total) {
        if (keys[keys.length - 1] !== index) keys.push(index);
        next += 1;
      }
    }
    const baked = keys.map((index) => {
      const list = byTime.get(steps[index]!)!;
      const quads = list.map((sample) => ({
        file: sample.file,
        uv: sample.uv,
        emission: sample.emission.map((value) => value / seedCount) as unknown as readonly [number, number, number],
        corners: sample.corners.map((corner) => [corner.x / units.x, corner.y / units.y] as const),
      }));
      const key = `swarm|${spec.name}|${width}|${bloomScale.toFixed(2)}|${steps[index]}`;
      const result = bakeCompositeHalo(key, quads, 0, 5, BLOOM_GAIN, SWARM_DENSITY, bloomScale, false, 2);
      let peak = 0;
      for (let p = 3; p < result.tile.image.pixels.length; p += 4) peak = Math.max(peak, result.tile.image.pixels[p]!);
      return { index, key, result, peak: peak / 255 };
    });
    if (Math.max(...baked.map((entry) => entry.peak)) < SWARM_VISIBILITY) return [];
    for (const entry of baked) compositeHalos.set(entry.key, entry.result);
    const plane = majorityPlane(particles.slice(0, 64));
    return baked.map((entry, k) => ({
      plane,
      build: (sprites) => {
        const sprite = sprites.get(entry.key);
        if (sprite === undefined) return undefined;
        const { rect } = entry.result;
        const x = ((rect.x0 + rect.x1) / 2) * units.x;
        const y = ((rect.y0 + rect.y1) / 2) * units.y;
        const w = ((rect.x1 - rect.x0) / 2) * units.x;
        const h = ((rect.y1 - rect.y0) / 2) * units.y;
        // Triangle cross-fade between neighbouring keyframes, scaled by the
        // energy relative to this keyframe (the tile is baked at its own).
        const own = energies[entry.index]!;
        const prev = k > 0 ? baked[k - 1]!.index : 0;
        const nextIndex = k < baked.length - 1 ? baked[k + 1]!.index : steps.length - 1;
        const params: Array<{ q: number; a: number }> = [];
        for (let index = prev; index <= nextIndex; index += 1) {
          const weight =
            index <= entry.index
              ? k === 0
                ? 1
                : (index - prev) / Math.max(1, entry.index - prev)
              : k === baked.length - 1
                ? 1
                : (nextIndex - index) / Math.max(1, nextIndex - entry.index);
          params.push({
            q: progressOf(steps[index]! * SAMPLE_STEP),
            a: Math.max(0, Math.min(1, weight * responseAt(entry.result.tile, energies[index]! / Math.max(1e-9, own)))),
          });
        }
        const start = Math.max(0, params[0]!.q);
        const end = Math.min(1, params[params.length - 1]!.q + SAMPLE_STEP / spec.lifetime);
        const duration = Math.max(1e-4, end - start);
        const build = (q0: number, q1: number): ChannelObservations => {
          const observations = emptyObservations();
          const span = Math.max(1e-9, q1 - q0);
          for (const param of params) {
            const q = (param.q - start) / duration;
            if (q < q0 - 1e-9 || q > q1 + 1e-9) continue;
            const local = (q - q0) / span;
            observations.x.push({ q: local, r: [], v: x });
            observations.y.push({ q: local, r: [], v: y });
            observations.w.push({ q: local, r: [], v: w });
            observations.h.push({ q: local, r: [], v: h });
            observations.r.push({ q: local, r: [], v: 0 });
            observations.a.push({ q: local, r: [], v: param.a });
          }
          return observations;
        };
        return {
          count: 1,
          particles: particleDefs(sprite, start, duration, fitPieces(build, false, 4)),
          ...debugTag(`swarm ${k}`),
        };
      },
    }));
  }

  /**
   * LiveUrpBloom's wide mips (15..62 px) become radial kernel particles at the
   * flux centroid of each GLOW_CELL px screen cell. Sonolus composites with
   * "over", not additive, so overlapping cells over-brighten; measured against
   * the web renderer one cell per effect (the default) is closest.
   */
  function glowGroups(
    meshSamples: readonly QuadSample[],
    particleSamples: readonly ParticleSample[],
    width: number,
    progressOf: (t: number) => number,
    spec: EffectSpec,
    seedCount: number,
    glow: { key: string; kernel: BloomKernel },
  ): PendingGroup[] {
    const kernel = glow.kernel;
    const units = unitsPerPixel(width / 4);
    const steps = Math.round(spec.lifetime / SAMPLE_STEP);
    interface Cell {
      flux: Map<number, number>;
      /** Per-time flux centroid (the glow follows the effect as it rises). */
      centroid: Map<number, [number, number, number]>;
      chroma: [number, number, number];
      px: number;
      py: number;
      weight: number;
    }
    const cells = new Map<string, Cell>();
    const add = (sample: QuadSample, share: number) => {
      const p = progressOf(sample.t);
      if (p < -1e-9 || p > 1 + 1e-9) return;
      const flux = prefilteredFlux(sample.file, sample.uv, sample.emission);
      const amount = sample.pixelArea * share;
      const peak = Math.max(...flux) * amount;
      if (peak <= 0) return;
      const [c0, , c2] = sample.corners;
      const x = (c0.x + c2.x) / 2;
      const y = (c0.y + c2.y) / 2;
      const key = `${Math.floor(x / units.x / GLOW_CELL)}:${Math.floor(y / units.y / GLOW_CELL)}`;
      let cell = cells.get(key);
      if (!cell)
        cells.set(key, (cell = { flux: new Map(), centroid: new Map(), chroma: [0, 0, 0], px: 0, py: 0, weight: 0 }));
      const bin = Math.round(p * steps);
      cell.flux.set(bin, (cell.flux.get(bin) ?? 0) + peak);
      const centroid = cell.centroid.get(bin) ?? [0, 0, 0];
      centroid[0] += x * peak;
      centroid[1] += y * peak;
      centroid[2] += peak;
      cell.centroid.set(bin, centroid);
      for (let c = 0; c < 3; c += 1) cell.chroma[c]! += flux[c]! * amount;
      cell.px += x * peak;
      cell.py += y * peak;
      cell.weight += peak;
    };
    for (const sample of meshSamples) add(sample, 1);
    // Particles are traced for every seed; average them.
    for (const sample of particleSamples) add(sample, 1 / seedCount);
    const groups: PendingGroup[] = [];
    for (const cell of cells.values()) {
      const params: Array<{ q: number; a: number; x: number; y: number }> = [];
      let last: [number, number] = [cell.px / cell.weight, cell.py / cell.weight];
      for (let step = 0; step <= steps; step += 1) {
        const centroid = cell.centroid.get(step);
        if (centroid && centroid[2] > 0) last = [centroid[0] / centroid[2], centroid[1] / centroid[2]];
        params.push({
          q: step / steps,
          a: kernelAlpha(kernel.centerGain * (cell.flux.get(step) ?? 0)),
          x: last[0],
          y: last[1],
        });
      }
      if (Math.max(...params.map((param) => param.a)) < GLOW_VISIBILITY) continue;
      const peakChroma = Math.max(...cell.chroma);
      const hex = hexColor(cell.chroma.map((value) => value / peakChroma));
      groups.push({
        plane: 0,
        build: (sprites) => {
          const sprite = sprites.get(glow.key);
          if (sprite === undefined) return undefined;
          const w = kernel.extent * units.x;
          const h = kernel.extent * units.y;
          const build = (q0: number, q1: number): ChannelObservations => {
            const observations = emptyObservations();
            const span = Math.max(1e-9, q1 - q0);
            for (const param of params) {
              if (param.q < q0 - 1e-9 || param.q > q1 + 1e-9) continue;
              const local = (param.q - q0) / span;
              observations.x.push({ q: local, r: [], v: param.x });
              observations.y.push({ q: local, r: [], v: param.y });
              observations.w.push({ q: local, r: [], v: w });
              observations.h.push({ q: local, r: [], v: h });
              observations.r.push({ q: local, r: [], v: 0 });
              observations.a.push({ q: local, r: [], v: param.a });
            }
            return observations;
          };
          return { count: 1, particles: particleDefs(sprite, 0, 1, fitPieces(build, false, MAX_MESH_PIECES), hex) };
        },
      });
    }
    return groups;
  }

  /**
   * Bloom (mips 1..RIG_HALO_MIPS) of each rig family (frame, wall, one pillar)
   * rendered as a whole, so neighbouring slices/strips bloom together as the
   * effect camera sees them. One low-density tile and one static quad per
   * family; its alpha follows the family's traced intensity.
   */
  function compositeHaloGroups(
    meshes: ReadonlyMap<string, readonly QuadSample[]>,
    width: number,
    progressOf: (t: number) => number,
    spec: EffectSpec,
  ): PendingGroup[] {
    const units = unitsPerPixel(width / 4);
    const families = new Map<string, Array<readonly QuadSample[]>>();
    for (const [key, list] of meshes) {
      const family = key.split("#")[0]!;
      let entry = families.get(family);
      if (!entry) families.set(family, (entry = []));
      entry.push(list.filter((sample) => progressOf(sample.t) <= 1 + 1e-9));
    }
    const groups: PendingGroup[] = [];
    for (const [family, trajectories] of families) {
      // Family intensity per time step (sum over its quads).
      const byStep = new Map<number, QuadSample[]>();
      for (const list of trajectories)
        for (const sample of list) {
          const step = Math.round((progressOf(sample.t) * spec.lifetime) / SAMPLE_STEP);
          let entry = byStep.get(step);
          if (!entry) byStep.set(step, (entry = []));
          entry.push(sample);
        }
      const total = (samples: readonly QuadSample[]) =>
        samples.reduce((sum, sample) => sum + intensity(sample.emission) * sample.pixelArea, 0);
      let peakStep = -1;
      let peak = 0;
      for (const [step, samples] of byStep) {
        const value = total(samples);
        if (value > peak) {
          peak = value;
          peakStep = step;
        }
      }
      if (peakStep < 0 || peak <= 0) continue;
      const snapshot = byStep.get(peakStep)!;
      const quads = snapshot.map((sample) => ({
        file: sample.file,
        uv: sample.uv,
        emission: sample.emission,
        corners: sample.corners.map((corner) => [corner.x / units.x, corner.y / units.y] as const),
      }));
      // Shape relative to the family's own box (a pillar's halo is the same
      // at every note width), chroma only (alpha follows traced intensity).
      const originX = Math.min(...quads.flatMap((quad) => quad.corners.map(([x]) => x)));
      const originY = Math.min(...quads.flatMap((quad) => quad.corners.map(([, y]) => y)));
      // Wall and frame are uniform along x between fixed ends: one bake per
      // colour, 3-sliced to every width (SLICED_FAMILIES).
      const sliced = SLICED_FAMILIES.has(family);
      const signature = JSON.stringify(
        quads.map((quad) => [
          quad.file.split("/").pop(),
          quad.emission.map((value) => Math.round((value / Math.max(1e-9, intensity(quad.emission))) * 8)),
          sliced ? [] : quad.corners.map(([x, y]) => [Math.round(x - originX), Math.round(y - originY)]),
        ]),
      );
      const maxX = Math.max(...quads.flatMap((quad) => quad.corners.map(([x]) => x)));
      const maxY = Math.max(...quads.flatMap((quad) => quad.corners.map(([, y]) => y)));
      for (const layer of COMPOSITE_LAYERS) {
        if (layer.families !== "all" && layer.families !== family) continue;
        const key = `composite|${layer.label}|${family}|${bloomScale.toFixed(2)}|${signature}`;
        let baked = compositeHalos.get(key);
        if (!baked) {
          const local = quads.map((quad) => ({
            ...quad,
            corners: quad.corners.map(([x, y]) => [x - originX, y - originY] as const),
          }));
          baked = bakeCompositeHalo(
            key,
            local,
            layer.mipFrom,
            layer.mipTo,
            BLOOM_GAIN,
            layer.density,
            bloomScale,
            "core" in layer && layer.core,
          );
          compositeHalos.set(key, baked);
        }
        // The baked padding around the family box is the same at every width.
        const padX = -baked.rect.x0;
        const padY = -baked.rect.y0;
        const rect = { x0: originX - padX, x1: maxX + padX, y0: originY - padY, y1: maxY + padY };
        const tile = baked.tile;
        // Pieces: [unit-space x0, x1, key suffix]. Sliced families stretch a
        // one-texel middle column between their fixed-size ends.
        const bakedWidth = baked.rect.x1 - baked.rect.x0;
        const endWidth = Math.min(bakedWidth / 2 - 1, padX + SLICE_END_MARGIN);
        const pieces: Array<[number, number, string]> =
          sliced && endWidth > 0
            ? [
                [rect.x0, rect.x0 + endWidth, "L"],
                [rect.x0 + endWidth, rect.x1 - endWidth, "M"],
                [rect.x1 - endWidth, rect.x1, "R"],
              ]
            : [[rect.x0, rect.x1, ""]];
        if (sliced && endWidth > 0) sliceTiles(key, baked, endWidth);
        const params = [...byStep.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([step, samples]) => ({
            q: (step * SAMPLE_STEP) / spec.lifetime,
            a: responseAt(tile, total(samples) / peak),
          }));
        const largest = snapshot.reduce(
          (best, sample) => (sample.pixelArea > best.pixelArea ? sample : best),
          snapshot[0]!,
        );
        const plane = planeOf(largest);
        for (const [pieceX0, pieceX1, suffix] of pieces)
          groups.push({
            plane,
            build: (sprites) => {
              const sprite = sprites.get(suffix ? `${key}|${suffix}` : key);
              if (sprite === undefined) return undefined;
              const x = ((pieceX0 + pieceX1) / 2) * units.x;
              const y = ((rect.y0 + rect.y1) / 2) * units.y;
              const w = ((pieceX1 - pieceX0) / 2) * units.x;
              const h = ((rect.y1 - rect.y0) / 2) * units.y;
              const start = Math.max(0, params[0]!.q - SAMPLE_STEP / 2 / spec.lifetime);
              const end = Math.min(1, params[params.length - 1]!.q + SAMPLE_STEP / spec.lifetime);
              const duration = Math.max(1e-4, end - start);
              const build = (q0: number, q1: number): ChannelObservations => {
                const observations = emptyObservations();
                const span = Math.max(1e-9, q1 - q0);
                for (const param of params) {
                  const q = (param.q - start) / duration;
                  if (q < q0 - 1e-9 || q > q1 + 1e-9) continue;
                  const local = (q - q0) / span;
                  observations.x.push({ q: local, r: [], v: x });
                  observations.y.push({ q: local, r: [], v: y });
                  observations.w.push({ q: local, r: [], v: w });
                  observations.h.push({ q: local, r: [], v: h });
                  observations.r.push({ q: local, r: [], v: 0 });
                  observations.a.push({ q: local, r: [], v: param.a });
                }
                return observations;
              };
              return {
                count: 1,
                particles: particleDefs(sprite, start, duration, fitPieces(build, false, MAX_MESH_PIECES)),
                ...debugTag(`halo ${layer.label} ${family}${suffix}`),
              };
            },
          });
      }
    }
    return groups;
  }
}
