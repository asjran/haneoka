import { EASES, ease, fitAnchoredChannel, type EaseName, type Observation } from "./fit.ts";

type Channel = "x" | "y" | "w" | "h" | "r" | "a";
type Values = Record<Channel, number>;
export interface ConstantParticleChannel {
  from: Record<string, number>;
  to: Record<string, number>;
  ease?: string;
}
export interface TrajectoryParticle {
  sprite: number;
  color: string;
  start: number;
  duration: number;
  x: ConstantParticleChannel;
  y: ConstantParticleChannel;
  w: ConstantParticleChannel;
  h: ConstantParticleChannel;
  r: ConstantParticleChannel;
  a: ConstantParticleChannel;
}
export interface TrajectoryCompressionOptions {
  /** Projection into the chosen output pixel grid, including the spawn plane. */
  project: (x: number, y: number) => readonly [number, number];
  /** Mean linear RGB luminance times alpha of the actual sprite and tint. */
  coverage: number;
  loop: boolean;
  brightPixelError?: number;
  dimPixelError?: number;
  absoluteFluxError?: number;
  relativeFluxError?: number;
}
export interface TrajectoryCompressionReport {
  input: number;
  output: number;
  peakReferenceFlux: number;
  maxCenterError: number;
  maxCornerError: number;
  maxFluxError: number;
  referenceAreaTimeIntegral: number;
  candidateAreaTimeIntegral: number;
  referenceNonlinearTimeIntegral: number;
  candidateNonlinearTimeIntegral: number;
}
const channels: readonly Channel[] = ["x", "y", "w", "h", "r", "a"];
const fractions = [0, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 3 / 4, 7 / 8, 15 / 16, 1];
const nonlinear = (name: string | undefined) => name !== "none" && name !== "linear";
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** Retire a continuous phase before its successor for both double and Float32 clocks. Do not round the result. */
export function durationBeforeNextPhase(start: number, nextStart: number): number {
  if (!Number.isFinite(start) || !Number.isFinite(nextStart) || nextStart <= start)
    throw new Error("Continuous particle phases require increasing finite times");
  const end = new Float32Array([nextStart]);
  const bits = new Uint32Array(end.buffer);
  let duration: number;
  do {
    if (end[0] === 0) bits[0] = 0x80000001;
    else if (end[0]! > 0) bits[0]!--;
    else bits[0]!++;
    duration = end[0]! - start;
    if (!(duration > 0)) throw new Error("Particle phase is shorter than one Float32 clock step");
  } while (start + duration >= nextStart ||
    Math.fround(Math.fround(start) + Math.fround(duration)) >= Math.fround(nextStart));
  return duration;
}

export interface SourceAlphaTrajectoryOptions {
  /** Authored loop boundaries that retain independent material phases. */
  breakpoints?: readonly number[];
  fitMetric?: "rms" | "max";
  /** Preserve narrow HDR exposure boundaries while keeping the default rig phase tolerance. */
  minimumKnotSeparation?: number;
  eases?: readonly EaseName[];
  alphaKnots?: readonly number[];
  alpha: (time: number) => number;
  tint?: (time: number) => readonly [number, number, number];
  maxTintError?: number;
  /** Peak premultiplied RGB of the carrier; tint error is measured after texture modulation. */
  tintScale?: readonly [number, number, number];
  start?: number;
  end?: number;
  knots: readonly number[];
  zeroKnots: readonly number[];
  /** Include every target viewport, lane and effect-size boundary here. */
  projects: readonly ((x: number, y: number) => readonly [number, number])[];
  maxPixelError: number;
  maxAlphaError: number;
  sprite: number;
}

/** Fit a material envelope against an existing fixed motion program. */
export function fitSourceAlphaTrajectory(
  source: readonly TrajectoryParticle[],
  options: SourceAlphaTrajectoryOptions,
): { particles: TrajectoryParticle[]; maxCornerError: number; maxAlphaError: number; maxTintError: number } {
  if (!source.length || source.some((p) => channels.some((c) => [p[c].from, p[c].to].some((v) => Object.keys(v).some((key) => key !== "c")))))
    throw new Error("Source material trajectories require fixed motion identities");
  const start = options.start ?? source[0]!.start;
  const end = options.end ?? source.at(-1)!.start + source.at(-1)!.duration;
  const eases: readonly EaseName[] = options.eases ?? ["linear", ...(["Quad", "Cubic", "Quart", "Quint"] as const).flatMap((name) =>
    [`in${name}`, `out${name}`, `inOut${name}`, `outIn${name}`] as EaseName[])];
  const knots = [...new Set([start, end, ...options.knots, ...source.flatMap((p) => [p.start, p.start + p.duration])])]
    .filter((v) => v >= start && v <= end).sort((a, b) => a - b)
    .filter((v, i, a) => !i || v - a[i - 1]! > (options.minimumKnotSeparation ?? 1e-7));
  const fixedGeometry = source.every((particle) => channels.filter((channel) => channel !== "a").every((channel) =>
    particle[channel].from.c === source[0]![channel].from.c && particle[channel].to.c === source[0]![channel].from.c));
  const fixedValues = fixedGeometry ? values(source[0]!, 0) : undefined;
  const alphaValues = new Map<number, number>();
  const alphaAt = (time: number): number => {
    const cached = alphaValues.get(time);
    if (cached !== undefined) return cached;
    const value = options.alpha(time);
    if (alphaValues.size >= 65536) alphaValues.clear();
    alphaValues.set(time, value);
    return value;
  };
  const reference = (time: number): Values => {
    if (fixedValues) return fixedValues;
    const particle = source.find((p) => time >= p.start - 1e-9 && time <= p.start + p.duration + 1e-9)
      ?? source.reduce((a, b) => {
        // Serialized phase rounding leaves tiny gaps; clamp to the adjacent motion.
        const distance = (p: TrajectoryParticle) => Math.max(p.start - time, time - p.start - p.duration, 0);
        return distance(a) <= distance(b) ? a : b;
      });
    return values(particle, (time - particle.start) / particle.duration);
  };
  interface Fit { particle?: TrajectoryParticle; corner: number; alpha: number; tint: number }
  const fits = new Map<string, Fit>();
  const fit = (a: number, b: number): Fit => {
    const key = `${a}:${b}`;
    const cached = fits.get(key);
    if (cached) return cached;
    if (options.breakpoints?.some((time) => time > a + 1e-8 && time < b - 1e-8))
      return { corner: Infinity, alpha: Infinity, tint: Infinity };
    if (options.zeroKnots.some((t) => t > a + 1e-8 && t < b - 1e-8)) return { corner: Infinity, alpha: Infinity, tint: Infinity };
    // A material interval preserves the old motion's own boundary side.
    const at = (t: number) => reference(Math.abs(t - a) < 1e-10 ? a + 1e-8 : Math.abs(t - b) < 1e-10 ? b - 1e-8 : t);
    const times = [...new Set([...Array.from({ length: 49 }, (_, i) => a + ((b - a) * i) / 48), ...knots.filter((t) => t > a && t < b),
      ...(options.alphaKnots ?? []).filter((t) => t > a && t < b)])]
      .sort((a, b) => a - b);
    const particle = { sprite: options.sprite, color: "#ffffff", start: a, duration: b - a } as TrajectoryParticle;
    const wholeSource = source.find((p) => Math.abs(p.start - a) < 1e-8 && Math.abs(p.start + p.duration - b) < 1e-8);
    let alphaUpper = 0;
    for (const channel of channels) {
      if (channel !== "a" && wholeSource) { particle[channel] = structuredClone(wholeSource[channel]); continue; }
      if (channel !== "a" && fixedValues) {
        const value = round(fixedValues[channel]);
        particle[channel] = { from: { c: value }, to: { c: value }, ease: "none" };
        continue;
      }
      const observations = times.map((time, i) => ({
        q: i === 0 ? 0 : i === times.length - 1 ? 1 : (time - a) / (b - a),
        r: [], v: channel === "a" ? alphaAt(time) : at(time)[channel], w: 1,
      }));
      const fitted = fitAnchoredChannel(observations, eases, options.fitMetric,
        channel === "a" ? options.maxAlphaError : Infinity);
      const from = round(fitted.from[0]!), to = round(fitted.to[0]!);
      if (channel === "a" && options.fitMetric === "max")
        alphaUpper = fitted.max + Math.max(Math.abs(from - fitted.from[0]!), Math.abs(to - fitted.to[0]!));
      particle[channel] = { from: { c: from }, to: { c: to }, ease: from === to ? "none" : fitted.ease };
    }
    let corner = 0, alpha = alphaUpper, tint = 0;
    let fixedTint = [1, 1, 1];
    if (options.tint) {
      const weight = times.reduce((n, t) => n + alphaAt(t) ** 2, 0);
      fixedTint = [0, 1, 2].map((c) => {
        const samples = times.map((t) => ({ value: options.tint!(t)[c]!, weight: alphaAt(t) * (options.tintScale?.[c] ?? 1) }));
        const mean = clamp(times.reduce((n, t) => n + options.tint!(t)[c]! * alphaAt(t) ** 2, 0) / Math.max(1e-12, weight));
        let low = 0, high = 1;
        for (let iteration = 0; iteration < 24; iteration++) {
          const error = (low + high) / 2;
          const from = Math.max(0, ...samples.map((s) => s.weight > 1e-9 ? s.value - error / s.weight : 0));
          const to = Math.min(1, ...samples.map((s) => s.weight > 1e-9 ? s.value + error / s.weight : 1));
          if (from <= to) high = error; else low = error;
        }
        const from = Math.max(0, ...samples.map((s) => s.weight > 1e-9 ? s.value - high / s.weight : 0));
        const to = Math.min(1, ...samples.map((s) => s.weight > 1e-9 ? s.value + high / s.weight : 1));
        const middle = Math.max(from, Math.min(to, mean));
        const bytes = [...new Set([Math.floor(middle * 255), Math.ceil(middle * 255)])];
        return bytes.map((byte) => ({ value: byte / 255, error: Math.max(...samples.map((s) => s.weight * Math.abs(byte / 255 - s.value))) }))
          .sort((a, b) => a.error - b.error)[0]!.value;
      });
      particle.color = "#" + fixedTint.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
    }
    if (fixedValues) for (const project of options.projects) {
      const original = footprint(fixedValues, { project, coverage: 1, loop: false }).corners;
      const candidate = footprint(values(particle, 0), { project, coverage: 1, loop: false }).corners;
      for (let i = 0; i < 4; i++) corner = Math.max(corner, Math.hypot(candidate[i]![0] - original[i]![0], candidate[i]![1] - original[i]![1]));
    }
    for (const time of times) {
      const candidate = fixedValues ? { ...fixedValues, a: (particle.a.from.c ?? 0) + ((particle.a.to.c ?? 0) - (particle.a.from.c ?? 0)) * ease(particle.a.ease as EaseName, clamp((time - a) / (b - a))) } : values(particle, (time - a) / (b - a)), original = at(time);
      alpha = Math.max(alpha, Math.abs(candidate.a - alphaAt(time)));
      if (options.tint) for (let c = 0; c < 3; c++) tint = Math.max(tint, Math.abs(fixedTint[c]! - options.tint(time)[c]!) * alphaAt(time) * (options.tintScale?.[c] ?? 1));
      for (const project of fixedValues ? [] : options.projects) {
        const shape = (v: Values) => footprint(v, { project, coverage: 1, loop: false }).corners;
        const x = shape(candidate), y = shape(original);
        for (let i = 0; i < 4; i++) corner = Math.max(corner, Math.hypot(x[i]![0] - y[i]![0], x[i]![1] - y[i]![1]));
      }
    }
    const result = { particle, corner, alpha, tint };
    fits.set(key, result);
    return result;
  };
  const acceptable = (value: Fit) => value.corner <= options.maxPixelError && value.alpha <= options.maxAlphaError && value.tint <= (options.maxTintError ?? Infinity);
  const atoms: Array<{ start: number; end: number }> = [];
  const split = (a: number, b: number, depth = 0): void => {
    if (!acceptable(fit(a, b)) && depth < 8) {
      const middle = (a + b) / 2;
      split(a, middle, depth + 1); split(middle, b, depth + 1);
    } else atoms.push({ start: a, end: b });
  };
  for (let i = 1; i < knots.length; i++) split(knots[i - 1]!, knots[i]!);
  const cuts = [atoms[0]!.start, ...atoms.map((p) => p.end)];
  const shortest: Array<Fit[] | undefined> = new Array(cuts.length);
  shortest[0] = [];
  for (let j = 1; j < cuts.length; j++)
    for (let i = 0; i < j; i++) {
      const previous = shortest[i];
      if (!previous) continue;
      const candidate = fit(cuts[i]!, cuts[j]!);
      if (acceptable(candidate) && (!shortest[j] || previous.length + 1 < shortest[j]!.length)) shortest[j] = [...previous, candidate];
    }
  if (!shortest.at(-1)) throw new Error("Source alpha trajectory exceeds its geometry or alpha budget");
  const selected = shortest.at(-1)!.filter((p) => Math.max(p.particle!.a.from.c ?? 0, p.particle!.a.to.c ?? 0) > 1e-9);
  return {
    particles: selected.map((p) => ({ ...p.particle!, start: Math.round(p.particle!.start * 1e8) / 1e8, duration: Math.round(p.particle!.duration * 1e8) / 1e8 })),
    maxCornerError: Math.max(0, ...selected.map((p) => p.corner)),
    maxAlphaError: Math.max(0, ...selected.map((p) => p.alpha)),
    maxTintError: Math.max(0, ...selected.map((p) => p.tint)),
  };
}

export function trajectoryCoverage(image: { width: number; height: number; pixels: Uint8Array }): number {
  let sum = 0;
  for (let offset = 0; offset < image.pixels.length; offset += 4)
    sum +=
      ((0.2126 * image.pixels[offset]! + 0.7152 * image.pixels[offset + 1]! + 0.0722 * image.pixels[offset + 2]!) /
        255) *
      (image.pixels[offset + 3]! / 255);
  return sum / (image.width * image.height);
}

function values(particle: TrajectoryParticle, q: number): Values {
  return Object.fromEntries(
    channels.map((channel) => {
      const curve = particle[channel];
      const from = curve.from.c ?? 0;
      return [channel, from + ((curve.to.c ?? 0) - from) * ease((curve.ease ?? "linear") as EaseName, clamp(q))];
    }),
  ) as Values;
}

interface Footprint {
  center: readonly [number, number];
  corners: Array<readonly [number, number]>;
  area: number;
  flux: number;
}
function footprint(value: Values, options: TrajectoryCompressionOptions): Footprint {
  const cos = Math.cos(value.r),
    sin = Math.sin(value.r);
  const corners = [
    [-value.w, -value.h],
    [-value.w, value.h],
    [value.w, value.h],
    [value.w, -value.h],
  ].map(([x, y]) => options.project(value.x + x! * cos - y! * sin, value.y + x! * sin + y! * cos));
  const area =
    Math.abs(
      corners.reduce((sum, a, index) => {
        const b = corners[(index + 1) % 4]!;
        return sum + a[0] * b[1] - a[1] * b[0];
      }, 0),
    ) / 2;
  return { center: options.project(value.x, value.y), corners, area, flux: area * clamp(value.a) * options.coverage };
}

interface Sample {
  t: number;
  weight: number;
  value: Values;
  footprint: Footprint;
  nonlinear: number;
}
interface Piece {
  particle: TrajectoryParticle;
  samples: Sample[];
}
interface Merge extends Piece {
  score: number;
}

/** Compress fixed Source trajectories without introducing random regression. */
export function compressSourceTrajectory(
  particles: readonly TrajectoryParticle[],
  options: TrajectoryCompressionOptions,
): { particles: TrajectoryParticle[]; report: TrajectoryCompressionReport } {
  const report: TrajectoryCompressionReport = {
    input: particles.length,
    output: particles.length,
    peakReferenceFlux: 0,
    maxCenterError: 0,
    maxCornerError: 0,
    maxFluxError: 0,
    referenceAreaTimeIntegral: 0,
    candidateAreaTimeIntegral: 0,
    referenceNonlinearTimeIntegral: 0,
    candidateNonlinearTimeIntegral: 0,
  };
  if (
    particles.length < 2 ||
    particles.some((particle) =>
      channels.some((channel) =>
        [particle[channel].from, particle[channel].to].some((expression) =>
          Object.keys(expression).some((key) => key !== "c"),
        ),
      ),
    )
  )
    return { particles: [...particles], report };
  let offset = 0,
    previous = -Infinity;
  const pieces: Piece[] = particles.map((original) => {
    if (options.loop && original.start + offset < previous - 1e-5) offset++;
    const particle = { ...original, start: original.start + offset };
    previous = particle.start;
    const samples = fractions.map((q, index) => {
      const value = values(particle, q);
      return {
        t: particle.start + particle.duration * q,
        weight:
          ((fractions[Math.min(fractions.length - 1, index + 1)]! - fractions[Math.max(0, index - 1)]!) / 2) *
          particle.duration,
        value,
        footprint: footprint(value, options),
        nonlinear: channels.filter((channel) => nonlinear(particle[channel].ease)).length,
      };
    });
    return { particle, samples };
  });
  const peakFlux = Math.max(...pieces.flatMap((piece) => piece.samples.map((sample) => sample.footprint.flux)));
  report.peakReferenceFlux = peakFlux;
  const brightError = options.brightPixelError ?? 0.65;
  const dimError = options.dimPixelError ?? 1.8;
  const absoluteFluxError = options.absoluteFluxError ?? 0.02;
  const fluxError = absoluteFluxError + peakFlux * (options.relativeFluxError ?? 0.08);

  const merge = (left: Piece, right: Piece): Merge | undefined => {
    const a = left.particle,
      b = right.particle;
    if (a.sprite !== b.sprite || a.color !== b.color || Math.abs(a.start + a.duration - b.start) > 3e-6)
      return undefined;
    const start = a.start,
      duration = b.start + b.duration - start;
    const samples = [...left.samples, ...right.samples];
    const particle = { ...a, duration };
    for (const channel of channels) {
      const observations: Observation[] = samples.map((sample) => ({
        q: clamp((sample.t - start) / duration),
        r: [],
        v: sample.value[channel],
        w: Math.max(0.001, Math.min(1, sample.footprint.flux / Math.max(1e-9, peakFlux))),
      }));
      const fit = fitAnchoredChannel(observations, EASES);
      const from = round(fit.from[0]!),
        to = round(fit.to[0]!);
      particle[channel] = { from: { c: from }, to: { c: to }, ease: from === to ? "none" : fit.ease };
    }
    let score = 0,
      referenceArea = 0,
      candidateArea = 0,
      referenceNonlinear = 0;
    for (const sample of samples) {
      const reference = sample.footprint;
      const candidate = footprint(values(particle, (sample.t - start) / duration), options);
      const contribution = Math.min(1, reference.flux / 0.75);
      const pixelError = brightError + (dimError - brightError) * (1 - contribution);
      const distance = (a: readonly [number, number], b: readonly [number, number]) =>
        Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (reference.flux >= 1 / 255 || candidate.flux >= absoluteFluxError) {
        score = Math.max(score, distance(reference.center, candidate.center) / pixelError);
        for (let corner = 0; corner < 4; corner++)
          score = Math.max(score, distance(reference.corners[corner]!, candidate.corners[corner]!) / pixelError);
      }
      score = Math.max(score, Math.abs(reference.flux - candidate.flux) / fluxError);
      // A visible pulse must keep its dark intervals and its bright peak.
      if (peakFlux >= 0.25 && reference.flux <= 1 / 255 && candidate.flux > absoluteFluxError) return undefined;
      if (reference.flux >= Math.max(0.25, peakFlux * 0.9) && candidate.flux < reference.flux * 0.9) return undefined;
      if (score > 1) return undefined;
      referenceArea += reference.area * sample.weight;
      candidateArea += candidate.area * sample.weight;
      referenceNonlinear += sample.nonlinear * sample.weight;
    }
    if (candidateArea > referenceArea * 1.015 + duration * 0.005) return undefined;
    const candidateNonlinear = channels.filter((channel) => nonlinear(particle[channel].ease)).length * duration;
    if (candidateNonlinear > referenceNonlinear + duration * 0.1) return undefined;
    return { particle, samples, score };
  };

  const candidates = pieces.slice(1).map((right, index) => merge(pieces[index]!, right));
  while (pieces.length > 1) {
    let best = -1;
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      if (candidate && (best < 0 || candidate.score < candidates[best]!.score)) best = index;
    }
    if (best < 0) break;
    pieces.splice(best, 2, candidates[best]!);
    candidates.splice(best, 1);
    if (best > 0) candidates[best - 1] = merge(pieces[best - 1]!, pieces[best]!);
    if (best + 1 < pieces.length) candidates[best] = merge(pieces[best]!, pieces[best + 1]!);
  }
  for (const piece of pieces)
    for (const sample of piece.samples) {
      const reference = sample.footprint;
      const candidate = footprint(
        values(piece.particle, (sample.t - piece.particle.start) / piece.particle.duration),
        options,
      );
      report.maxFluxError = Math.max(report.maxFluxError, Math.abs(reference.flux - candidate.flux));
      if (reference.flux >= 1 / 255) {
        report.maxCenterError = Math.max(
          report.maxCenterError,
          Math.hypot(reference.center[0] - candidate.center[0], reference.center[1] - candidate.center[1]),
        );
        for (let corner = 0; corner < 4; corner++)
          report.maxCornerError = Math.max(
            report.maxCornerError,
            Math.hypot(
              reference.corners[corner]![0] - candidate.corners[corner]![0],
              reference.corners[corner]![1] - candidate.corners[corner]![1],
            ),
          );
      }
      report.referenceAreaTimeIntegral += reference.area * sample.weight;
      report.candidateAreaTimeIntegral += candidate.area * sample.weight;
      report.referenceNonlinearTimeIntegral += sample.nonlinear * sample.weight;
      report.candidateNonlinearTimeIntegral +=
        channels.filter((channel) => nonlinear(piece.particle[channel].ease)).length * sample.weight;
    }
  const result = pieces.map(({ particle }) => ({
    ...particle,
    start: round(options.loop ? particle.start % 1 : particle.start),
    duration: round(particle.duration),
  }));
  report.output = result.length;
  return { particles: result, report };
}

export interface CarrierMoments {
  /** Weighted source RGB energy and per-channel carrier square/dot products. */
  target: number;
  peak: readonly [number, number, number];
  square: readonly [number, number, number];
  dot: readonly [number, number, number];
}
export interface SourceMaterialBasis {
  sprite: number;
  peak: readonly [number, number, number];
  covers?: (time: number) => boolean;
  momentsAt: (time: number) => CarrierMoments;
}
export interface SourceMaterialAlternative {
  count: number;
  weightedRms: number;
  maxCornerError: number;
  particles: TrajectoryParticle[];
}

/** Share one effect's program budget across its actual Source births. */
export function allocateSourceMaterialBudget(choices: readonly (readonly SourceMaterialAlternative[])[], budget: number) {
  type Path = { loss: number; selected: SourceMaterialAlternative[] };
  let paths: Array<Path | undefined> = new Array(budget + 1); paths[0] = { loss: 0, selected: [] };
  for (const alternatives of choices) {
    const next: Array<Path | undefined> = new Array(budget + 1);
    for (const [count, path] of paths.entries()) if (path) for (const alternative of alternatives) {
      const total = count + alternative.count; if (total > budget) continue;
      const particles = alternative.particles,
        span = particles.at(-1)!.start + particles.at(-1)!.duration - particles[0]!.start,
        loss = path.loss + alternative.weightedRms ** 2 * span;
      if (!next[total] || loss < next[total]!.loss)
        next[total] = { loss, selected: [...path.selected, alternative] };
    }
    paths = next;
  }
  const pareto = paths.flatMap((path, count) => path ? [{ count, ...path }] : []);
  const best = pareto.slice().sort((a, b) => a.loss - b.loss)[0];
  if (!best) throw new Error(`Source material needs at least ${choices.reduce((n, a) => n + (a[0]?.count ?? 0), 0)} programs; budget is ${budget}`);
  return { selected: best.selected, count: best.count,
    pareto: pareto.map((path) => ({ count: path.count, loss: path.loss,
      perBirth: path.selected.map((alternative) => alternative.count) })) };
}

/** Reuse a fixed phase budget for the material and the existing projected motion. */
export function fitBudgetedSourceMaterial(
  source: readonly TrajectoryParticle[],
  options: {
    bases: readonly SourceMaterialBasis[];
    knots: readonly number[];
    zeroKnots: readonly number[];
    projects: readonly ((x: number, y: number) => readonly [number, number])[];
    maxPixelError: number;
    maxParticles: number;
    alphaChannel?: 0 | 1 | 2;
  },
): { particles: TrajectoryParticle[]; maxCornerError: number; weightedRms: number; pareto: SourceMaterialAlternative[] } {
  if (!source.length || !options.bases.length || options.maxParticles < 1)
    throw new Error("A Source material fit requires motion, bases and a phase budget");
  const start = source[0]!.start, end = source.at(-1)!.start + source.at(-1)!.duration;
  const cuts = [...new Set([start, end, ...options.knots, ...options.zeroKnots,
    ...source.flatMap((p) => [p.start, p.start + p.duration])])]
    .filter((t) => t >= start && t <= end).sort((a, b) => a - b)
    .filter((t, i, a) => !i || t - a[i - 1]! > 1e-7);
  const reference = (time: number): Values => {
    const p = source.find((p) => time >= p.start - 1e-10 && time <= p.start + p.duration + 1e-10)
      ?? source.reduce((a, b) => {
        const distance = (p: TrajectoryParticle) => Math.max(p.start - time, time - p.start - p.duration, 0);
        return distance(a) < distance(b) ? a : b;
      });
    return values(p, (time - p.start) / p.duration);
  };
  type Phase = { particle: TrajectoryParticle; loss: number; corner: number };
  const cache = new Map<string, Phase | null>();
  const fit = (a: number, b: number): Phase | undefined => {
    const key = `${a}:${b}`;
    if (cache.has(key)) return cache.get(key) ?? undefined;
    if (options.zeroKnots.some((t) => t > a + 1e-7 && t < b - 1e-7)) {
      cache.set(key, null); return undefined;
    }
    const times = [...new Set([...Array.from({ length: 65 }, (_, i) => a + (b - a) * i / 64),
      ...cuts.filter((t) => t > a && t < b)])].sort((a, b) => a - b);
    const q = times.map((t) => (t - a) / (b - a));
    const geometry = { start: a, duration: b - a } as TrajectoryParticle;
    const whole = source.find((p) => Math.abs(p.start - a) < 1e-7 && Math.abs(p.start + p.duration - b) < 1e-7);
    const originalAt = (time: number) => whole ? values(whole, (time - whole.start) / whole.duration)
      : reference(Math.abs(time - a) < 1e-10 ? a + Math.min((b - a) / 4, 1e-7)
        : Math.abs(time - b) < 1e-10 ? b - Math.min((b - a) / 4, 1e-7) : time);
    const channels = ["x", "y", "w", "h", "r"] as const;
    const first = originalAt(a), last = originalAt(b);
    for (const channel of channels) geometry[channel] = {
      from: { c: first[channel] }, to: { c: last[channel] },
      ease: first[channel] === last[channel] ? "none" : "linear",
    };
    const cornerError = () => {
      let maximum = 0;
      for (const [i, time] of times.entries()) for (const project of options.projects) {
        const original = footprint(originalAt(time), { project, coverage: 1, loop: false }).corners;
        const candidate = footprint(values({ ...geometry, a: { from: {}, to: {} } }, q[i]!), { project, coverage: 1, loop: false }).corners;
        for (let n = 0; n < 4; n++) maximum = Math.max(maximum,
          Math.hypot(original[n]![0] - candidate[n]![0], original[n]![1] - candidate[n]![1]));
      }
      return maximum;
    };
    // Native evaluates every active channel each frame. Prefer linear motion
    // within the same projected Source tolerance before choosing a costlier ease.
    let corner = cornerError();
    if (corner > options.maxPixelError) {
      for (const channel of channels) {
        if (whole) {
          const original = whole[channel], keys = new Set([...Object.keys(original.from), ...Object.keys(original.to)]);
          geometry[channel] = { ...structuredClone(original), ease: [...keys].every((key) =>
            Number.isFinite(original.from[key] ?? 0) && Number.isFinite(original.to[key] ?? 0) &&
            (original.from[key] ?? 0) === (original.to[key] ?? 0)) ? "none" : original.ease ?? "linear" };
          continue;
        }
        const fitted = fitAnchoredChannel(times.map((t, i) => ({ q: q[i]!, r: [], v: originalAt(t)[channel] })), EASES, "max");
        geometry[channel] = { from: { c: fitted.from[0]! }, to: { c: fitted.to[0]! }, ease: fitted.from[0] === fitted.to[0] ? "none" : fitted.ease };
      }
      corner = cornerError();
    }
    if (corner > options.maxPixelError) { cache.set(key, null); return undefined; }
    let best: Phase | undefined;
    for (const basis of options.bases) {
      if (basis.covers && times.some((t) => !basis.covers!(t))) continue;
      const stats = times.map(basis.momentsAt).map((s) => {
        // Relative image error retains a blue nucleus while the other channels fade.
        const normalization = 1 / Math.max(1e-3, s.target);
        return { target: s.target * normalization, peak: s.peak,
          square: s.square.map((v) => v * normalization), dot: s.dot.map((v) => v * normalization) };
      }), tint = [1, 1, 1];
      let alpha = { from: { c: 1 }, to: { c: 1 }, ease: "none" as EaseName };
      const at = (n: number) => alpha.from.c + (alpha.to.c - alpha.from.c) * ease(alpha.ease, q[n]!);
      for (let iteration = 0; iteration < 4; iteration++) {
        const observations = stats.map((s, i) => ({ q: q[i]!, r: [], v: clamp(options.alphaChannel !== undefined
          ? s.peak[options.alphaChannel]! / Math.max(1e-12, basis.peak[options.alphaChannel]!)
          : [0, 1, 2].reduce((n, c) => n + tint[c]! * s.dot[c]!, 0) /
            Math.max(1e-12, [0, 1, 2].reduce((n, c) => n + tint[c]! ** 2 * s.square[c]!, 0))),
        }));
        const fitted = fitAnchoredChannel(observations, EASES, "max");
        alpha = { from: { c: clamp(fitted.from[0]!) }, to: { c: clamp(fitted.to[0]!) }, ease: fitted.from[0] === fitted.to[0] ? "none" : fitted.ease };
        for (let c = 0; c < 3; c++) tint[c] = clamp(stats.reduce((n, s, i) => n + at(i) * s.peak[c]! * basis.peak[c]!, 0) /
          Math.max(1e-12, stats.reduce((n, _s, i) => n + (at(i) * basis.peak[c]!) ** 2, 0)));
        if (options.alphaChannel !== undefined) { tint[options.alphaChannel] = 1; break; }
      }
      const bytes = tint.map((v) => Math.round(v * 255)), quantized = bytes.map((v) => v / 255);
      const losses = stats.map((s, i) => Math.max(0, s.target + [0, 1, 2].reduce((n, c) =>
        n + (at(i) * quantized[c]!) ** 2 * s.square[c]! - 2 * at(i) * quantized[c]! * s.dot[c]!, 0)));
      let loss = 0; for (let i = 1; i < times.length; i++) loss += (losses[i - 1]! + losses[i]!) / 2 * (times[i]! - times[i - 1]!);
      const particle = { ...geometry, sprite: basis.sprite, color: "#" + bytes.map((v) => v.toString(16).padStart(2, "0")).join(""), a: alpha };
      if (!best || loss < best.loss) best = { particle, loss, corner };
    }
    cache.set(key, best!); return best;
  };
  const phases: Phase[] = [];
  const append = (a: number, b: number, depth = 0): void => {
    const phase = fit(a, b);
    if (phase) { phases.push(phase); return; }
    if (depth >= 8) throw new Error(`Source motion atom ${a}..${b} exceeds geometric tolerance ${options.maxPixelError}`);
    const middle = (a + b) / 2;
    append(a, middle, depth + 1); append(middle, b, depth + 1);
  };
  for (let i = 1; i < cuts.length; i++) append(cuts[i - 1]!, cuts[i]!);
  const boundaries = [phases[0]!.particle.start, ...phases.map((p) => p.particle.start + p.particle.duration)];
  const maximumCount = Math.min(options.maxParticles, boundaries.length - 1);
  const paths: Array<Array<{ loss: number; phases: Phase[] } | undefined>> = Array.from(
    { length: maximumCount + 1 }, () => new Array(boundaries.length));
  paths[0]![0] = { loss: 0, phases: [] };
  for (let count = 1; count <= maximumCount; count++) for (let j = 1; j < boundaries.length; j++) {
    for (let i = count - 1; i < j; i++) {
      const previous = paths[count - 1]![i]; if (!previous) continue;
      const phase = fit(boundaries[i]!, boundaries[j]!); if (!phase) continue;
      const loss = previous.loss + phase.loss, current = paths[count]![j];
      if (!current || loss < current.loss) paths[count]![j] = { loss, phases: [...previous.phases, phase] };
    }
  }
  const selected = paths.flatMap((path) => path.at(-1) ? [path.at(-1)!] : []).sort((a, b) => a.loss - b.loss)[0];
  if (!selected) throw new Error("Source material cannot fit the original phase budget and geometry tolerance");
  phases.splice(0, phases.length, ...selected.phases);
  const particles = phases.map(({ particle }, i) => ({ ...particle,
    duration: i + 1 < phases.length ? durationBeforeNextPhase(particle.start, phases[i + 1]!.particle.start) : particle.duration,
  }));
  return { particles, maxCornerError: Math.max(...phases.map((p) => p.corner)),
    weightedRms: Math.sqrt(phases.reduce((n, p) => n + p.loss, 0) / Math.max(1e-12, end - start)),
    pareto: paths.flatMap((path, count) => path.at(-1) ? [{ count,
      weightedRms: Math.sqrt(path.at(-1)!.loss / Math.max(1e-12, end - start)),
      maxCornerError: Math.max(...path.at(-1)!.phases.map((p) => p.corner)),
      particles: path.at(-1)!.phases.map(({ particle }, i, phases) => ({ ...particle,
        duration: i + 1 < phases.length ? durationBeforeNextPhase(particle.start, phases[i + 1]!.particle.start) : particle.duration,
      })),
    }] : []),
  };
}

/** Inspect the selected, float-safe phases against their actual Source motion. */
export function auditSourceMaterialTrajectory(
  source: readonly TrajectoryParticle[],
  particles: readonly TrajectoryParticle[],
  projects: readonly ((x: number, y: number) => readonly [number, number])[],
  steps = 128,
) {
  const reference = (time: number) => {
    const original = source.find((p) => time >= p.start && time < p.start + p.duration)
      ?? source.reduce((a, b) => {
        const distance = (p: TrajectoryParticle) => Math.max(p.start - time, time - p.start - p.duration, 0);
        return distance(a) < distance(b) ? a : b;
      });
    return values(original, (time - original.start) / original.duration);
  };
  let maximumPixelError = 0, samples = 0, worstTime = 0, worstProject = 0;
  const boundaries = source.flatMap((p) => [p.start, p.start + p.duration]);
  for (const particle of particles) {
    const begin = particle.start, end = begin + particle.duration;
    const raw = [
      ...Array.from({ length: steps + 1 }, (_, i) => begin + particle.duration * i / steps),
      ...boundaries.flatMap((time) => [time - 1e-8, time, time + 1e-8]),
      Math.fround(begin), Math.fround(end),
    ];
    // The native interval is half-open. Inspect each edge from its active side.
    const times = [...new Set(raw.filter((t) => t >= begin && t <= end)
      .map((t) => Math.max(begin, Math.min(end - Math.min(1e-10, particle.duration / 4), t))))];
    for (const time of times) {
      const actual = values(particle, (time - begin) / particle.duration), expected = reference(time);
      for (const [index, project] of projects.entries()) {
        const a = footprint(actual, { project, coverage: 1, loop: false }).corners;
        const b = footprint(expected, { project, coverage: 1, loop: false }).corners;
        for (let corner = 0; corner < 4; corner++) {
          const error = Math.hypot(a[corner]![0] - b[corner]![0], a[corner]![1] - b[corner]![1]);
          if (error > maximumPixelError) { maximumPixelError = error; worstTime = time; worstProject = index; }
        }
        samples++;
      }
    }
  }
  const contacts = source.slice(1).map((p, i) => p.start - source[i]!.start - source[i]!.duration);
  return { maximumPixelError, worstTime, worstProject, samples, steps,
    sourceGaps: contacts.filter((v) => v > 1e-10).length,
    sourceOverlaps: contacts.filter((v) => v < -1e-10).length,
    timing: "Selected durationBeforeNextPhase output; dense active-side, Source-boundary and float32-edge samples" };
}
