/** Authored Unity particle math shared by renderers and offline compilers. */
type NativeRecord = Record<string, unknown>;

export interface NativeColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

const EMPTY_VALUES: ReadonlyArray<unknown> = [];
const ZERO_COLOR: NativeColor = { r: 0, g: 0, b: 0, a: 0 };

function record(value: unknown): NativeRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as NativeRecord) : undefined;
}

function array(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : EMPTY_VALUES;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, progress: number): number {
  return a + (b - a) * progress;
}

const UNITY_PARTICLE_RANDOM_MULTIPLIER = 0x6c078965;
const UNITY_PARTICLE_RANDOM_VALUE_SCALE = Math.fround(1 / 0x7fffff);

/** Unity's seeded particle random stream; `sampleParticle` draws with `seed + k`. */
export function nativeParticleRandom(seed: number): number {
  return random(seed);
}

function random(seed: number): number {
  // Unity's ParticleSystem jobs seed four xorshift words from this LCG, then
  // turn the low 23 bits of the first xorshift result into a float. The
  // renderer stays stateless so a particle can be reconstructed every frame,
  // but each derived stream uses the native generator rather than a guessed
  // one-word xorshift.
  const s0 = Math.trunc(seed) >>> 0;
  const s1 = (Math.imul(s0, UNITY_PARTICLE_RANDOM_MULTIPLIER) + 1) >>> 0;
  const s2 = (Math.imul(s1, UNITY_PARTICLE_RANDOM_MULTIPLIER) + 1) >>> 0;
  const s3 = (Math.imul(s2, UNITY_PARTICLE_RANDOM_MULTIPLIER) + 1) >>> 0;
  const temporary = (s0 ^ (s0 << 11)) >>> 0;
  const next = (temporary ^ s3 ^ (temporary >>> 8) ^ (s3 >>> 19)) >>> 0;
  return Math.fround(Math.fround(next & 0x7fffff) * UNITY_PARTICLE_RANDOM_VALUE_SCALE);
}

function cubic(a: number, b: number, c: number, d: number, value: number): number {
  const inverse = 1 - value;
  return (
    inverse * inverse * inverse * a +
    3 * inverse * inverse * value * b +
    3 * inverse * value * value * c +
    value * value * value * d
  );
}

const NATIVE_CURVE_LUT_SAMPLES = 512;
const NATIVE_CURVE_LUT_RELATIVE_ERROR = 0.001;
const NATIVE_CURVE_LUT_MIN_ERROR = 0.000001;
const NATIVE_CURVE_LUT_VALIDATION_PROGRESS = [0.25, 0.5, 0.75] as const;

interface NativeCurveLookup {
  readonly exact: boolean;
  readonly start: number;
  readonly end: number;
  readonly samples?: Float32Array;
  readonly maxAbsError: number;
  readonly tolerance: number;
}

export interface NativeCurveLutStats {
  builtCurves: number;
  lutCurves: number;
  exactFallbackCurves: number;
  maximumValidatedError: number;
  maximumTolerance: number;
  samplesPerCurve: number;
}

let nativeCurveLookupCache = new WeakMap<object, NativeCurveLookup>();
const nativeCurveLutStats: NativeCurveLutStats = {
  builtCurves: 0,
  lutCurves: 0,
  exactFallbackCurves: 0,
  maximumValidatedError: 0,
  maximumTolerance: 0,
  samplesPerCurve: NATIVE_CURVE_LUT_SAMPLES,
};

function resetNativeCurveLutStats(): void {
  nativeCurveLutStats.builtCurves = 0;
  nativeCurveLutStats.lutCurves = 0;
  nativeCurveLutStats.exactFallbackCurves = 0;
  nativeCurveLutStats.maximumValidatedError = 0;
  nativeCurveLutStats.maximumTolerance = 0;
}

/** Diagnostics are snapshots so callers cannot mutate the global cache counters. */
export function getNativeCurveLutStats(): NativeCurveLutStats {
  return { ...nativeCurveLutStats };
}

/** Test/benchmark hook; production never clears the atlas-lifetime curve cache. */
export function resetNativeCurveLutCache(): void {
  nativeCurveLookupCache = new WeakMap<object, NativeCurveLookup>();
  resetNativeCurveLutStats();
}

/** Evaluates Unity's serialized AnimationCurve, including weighted tangents. */
export function evaluateNativeAnimationCurve(value: unknown, time: number): number {
  const curve = record(value);
  const keys = array(curve?.m_Curve);
  const first = record(keys[0]);
  const last = record(keys[keys.length - 1]);
  if (!first || !last) return 0;
  if (time <= finite(first.time)) return finite(first.value);
  if (time >= finite(last.time)) return finite(last.value);
  let left = first;
  let right = last;
  for (let index = 1; index < keys.length; index += 1) {
    const candidate = record(keys[index]);
    if (!candidate) continue;
    if (time <= finite(candidate.time)) {
      right = candidate;
      break;
    }
    left = candidate;
  }
  const t0 = finite(left.time);
  const t1 = finite(right.time);
  const duration = Math.max(Number.EPSILON, t1 - t0);
  const v0 = finite(left.value);
  const v1 = finite(right.value);
  const outSlope = left.outSlope === undefined ? 0 : Number(left.outSlope);
  const inSlope = right.inSlope === undefined ? 0 : Number(right.inSlope);
  if (!Number.isFinite(outSlope) || !Number.isFinite(inSlope)) return time < t1 ? v0 : v1;
  const outWeighted = (Math.round(finite(left.weightedMode)) & 2) !== 0;
  const inWeighted = (Math.round(finite(right.weightedMode)) & 1) !== 0;
  const outWeight = outWeighted ? clamp(finite(left.outWeight, 1 / 3)) : 1 / 3;
  const inWeight = inWeighted ? clamp(finite(right.inWeight, 1 / 3)) : 1 / 3;
  const x1 = t0 + duration * outWeight;
  const x2 = t1 - duration * inWeight;
  const y1 = v0 + outSlope * duration * outWeight;
  const y2 = v1 - inSlope * duration * inWeight;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const middle = (low + high) / 2;
    if (cubic(t0, x1, x2, t1, middle) < time) low = middle;
    else high = middle;
  }
  return cubic(v0, y1, y2, v1, (low + high) / 2);
}

function hasNonFiniteCurveTangents(keys: ReadonlyArray<unknown>): boolean {
  for (const rawKey of keys) {
    const key = record(rawKey);
    if (!key) continue;
    for (const name of ["inSlope", "outSlope"] as const) {
      const raw = key[name];
      if (raw !== undefined && !Number.isFinite(Number(raw))) return true;
    }
  }
  return false;
}

function buildNativeCurveLookup(curve: NativeRecord): NativeCurveLookup {
  const keys = array(curve.m_Curve);
  const first = record(keys[0]);
  const last = record(keys[keys.length - 1]);
  nativeCurveLutStats.builtCurves += 1;
  if (!first || !last || hasNonFiniteCurveTangents(keys)) {
    nativeCurveLutStats.exactFallbackCurves += 1;
    return { exact: true, start: 0, end: 0, maxAbsError: 0, tolerance: 0 };
  }
  const start = finite(first.time);
  const end = finite(last.time);
  if (!(end > start)) {
    nativeCurveLutStats.exactFallbackCurves += 1;
    return { exact: true, start, end, maxAbsError: 0, tolerance: 0 };
  }
  const samples = new Float32Array(NATIVE_CURVE_LUT_SAMPLES);
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < samples.length; index += 1) {
    const time = start + ((end - start) * index) / (samples.length - 1);
    const sample = evaluateNativeAnimationCurve(curve, time);
    samples[index] = sample;
    minimum = Math.min(minimum, sample);
    maximum = Math.max(maximum, sample);
  }
  const tolerance = Math.max(NATIVE_CURVE_LUT_MIN_ERROR, (maximum - minimum) * NATIVE_CURVE_LUT_RELATIVE_ERROR);
  let maxAbsError = 0;
  // Validate every cell at quarter points. Curves with sharp/weighted segments that a
  // 512-sample linear LUT cannot represent within the declared tolerance use
  // the exact 18-step cubic solve instead.
  for (let index = 0; index < samples.length - 1; index += 1) {
    for (const progress of NATIVE_CURVE_LUT_VALIDATION_PROGRESS) {
      const time = start + ((end - start) * (index + progress)) / (samples.length - 1);
      const exact = evaluateNativeAnimationCurve(curve, time);
      const approximate = lerp(samples[index]!, samples[index + 1]!, progress);
      maxAbsError = Math.max(maxAbsError, Math.abs(exact - approximate));
    }
  }
  nativeCurveLutStats.maximumValidatedError = Math.max(nativeCurveLutStats.maximumValidatedError, maxAbsError);
  nativeCurveLutStats.maximumTolerance = Math.max(nativeCurveLutStats.maximumTolerance, tolerance);
  if (maxAbsError > tolerance) {
    nativeCurveLutStats.exactFallbackCurves += 1;
    return { exact: true, start, end, maxAbsError, tolerance };
  }
  nativeCurveLutStats.lutCurves += 1;
  return { exact: false, start, end, samples, maxAbsError, tolerance };
}

function nativeCurveLookup(value: unknown): NativeCurveLookup | undefined {
  const curve = record(value);
  if (!curve) return undefined;
  const cached = nativeCurveLookupCache.get(curve);
  if (cached) return cached;
  const lookup = buildNativeCurveLookup(curve);
  nativeCurveLookupCache.set(curve, lookup);
  return lookup;
}

function evaluateNativeAnimationCurveCached(value: unknown, time: number): number {
  const curve = record(value);
  if (!curve) return 0;
  const lookup = nativeCurveLookup(curve);
  const samples = lookup?.samples;
  if (!lookup || lookup.exact || !samples) return evaluateNativeAnimationCurve(curve, time);
  if (time <= lookup.start) return samples[0]!;
  if (time >= lookup.end) return samples[samples.length - 1]!;
  const position = ((time - lookup.start) / (lookup.end - lookup.start)) * (samples.length - 1);
  const left = Math.floor(position);
  const progress = position - left;
  return lerp(samples[left]!, samples[left + 1]!, progress);
}

/** Prewarm every serialized AnimationCurve in a decoded particle system. */
export function prepareNativeCurveLuts(value: unknown): void {
  const visited = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object") return;
    if (visited.has(candidate)) return;
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const object = candidate as NativeRecord;
    if (Array.isArray(object.m_Curve)) nativeCurveLookup(object);
    for (const child of Object.values(object)) visit(child);
  };
  visit(value);
}

function evaluateNativeMinMaxCurveWith(
  value: unknown,
  time: number,
  randomValue: number,
  evaluator: (curve: unknown, sampleTime: number) => number,
): number {
  const curve = record(value);
  if (!curve) return 0;
  const state = Math.round(finite(curve.minMaxState));
  const maximum = finite(curve.scalar);
  const minimum = finite(curve.minScalar);
  if (state === 0) return maximum;
  if (state === 1) return maximum * evaluator(curve.maxCurve, time);
  if (state === 2) {
    const minValue = minimum * evaluator(curve.minCurve, time);
    const maxValue = maximum * evaluator(curve.maxCurve, time);
    return lerp(minValue, maxValue, clamp(randomValue));
  }
  if (state === 3) return lerp(minimum, maximum, clamp(randomValue));
  return 0;
}

/** Evaluates Unity MinMaxCurve without substituting display defaults for missing values. */
export function evaluateNativeMinMaxCurve(value: unknown, time: number, randomValue = 0.5): number {
  return evaluateNativeMinMaxCurveWith(value, time, randomValue, evaluateNativeAnimationCurveCached);
}

/** Exact reference path retained for tests and difficult-curve fallback. */
export function evaluateNativeMinMaxCurveExact(value: unknown, time: number, randomValue = 0.5): number {
  return evaluateNativeMinMaxCurveWith(value, time, randomValue, evaluateNativeAnimationCurve);
}

export function serializedColor(value: unknown, target: NativeColor = { r: 0, g: 0, b: 0, a: 0 }): NativeColor {
  const color = record(value);
  target.r = finite(color?.r);
  target.g = finite(color?.g);
  target.b = finite(color?.b);
  target.a = finite(color?.a);
  return target;
}

export function quantizeParticleColor(color: NativeColor): void {
  color.r = Math.round(clamp(color.r) * 255) / 255;
  color.g = Math.round(clamp(color.g) * 255) / 255;
  color.b = Math.round(clamp(color.b) * 255) / 255;
  color.a = Math.round(clamp(color.a) * 255) / 255;
}

function gradientChannel(
  gradient: NativeRecord,
  time: number,
  component: "r" | "g" | "b" | "a",
  alphaTiming: boolean,
): number {
  const count = Math.max(
    0,
    Math.min(8, Math.round(finite(gradient[alphaTiming ? "m_NumAlphaKeys" : "m_NumColorKeys"]))),
  );
  if (count === 0) return 1;
  let leftIndex = 0;
  let leftTime = finite(gradient[`${alphaTiming ? "atime" : "ctime"}0`]) / 65535;
  let leftColor = record(gradient.key0);
  if (time <= leftTime) return finite(leftColor?.[component], 1);
  for (let index = 1; index < count; index += 1) {
    const rightTime = finite(gradient[`${alphaTiming ? "atime" : "ctime"}${index}`]) / 65535;
    const rightColor = record(gradient[`key${index}`]);
    if (time <= rightTime) {
      const progress =
        finite(gradient.m_Mode) === 1 ? 0 : (time - leftTime) / Math.max(Number.EPSILON, rightTime - leftTime);
      return lerp(finite(leftColor?.[component], 1), finite(rightColor?.[component], 1), progress);
    }
    leftIndex = index;
    leftTime = rightTime;
    leftColor = rightColor;
  }
  return finite(record(gradient[`key${leftIndex}`])?.[component], 1);
}

function evaluateGradient(value: unknown, time: number, target: NativeColor): NativeColor {
  const gradient = record(value);
  if (!gradient) {
    target.r = 1;
    target.g = 1;
    target.b = 1;
    target.a = 1;
    return target;
  }
  const progress = clamp(time);
  target.r = gradientChannel(gradient, progress, "r", false);
  target.g = gradientChannel(gradient, progress, "g", false);
  target.b = gradientChannel(gradient, progress, "b", false);
  target.a = gradientChannel(gradient, progress, "a", true);
  return target;
}

const GRADIENT_SCRATCH: NativeColor = { r: 0, g: 0, b: 0, a: 0 };

/** Evaluates Unity MinMaxGradient using one stable per-particle random value. */
export function evaluateNativeMinMaxGradient(
  value: unknown,
  time: number,
  randomValue = 0.5,
  target: NativeColor = { r: 0, g: 0, b: 0, a: 0 },
): NativeColor {
  const gradient = record(value);
  if (!gradient) {
    target.r = 1;
    target.g = 1;
    target.b = 1;
    target.a = 1;
    return target;
  }
  const state = Math.round(finite(gradient.minMaxState));
  if (state === 0) return serializedColor(gradient.maxColor, target);
  if (state === 1 || state === 4)
    return evaluateGradient(gradient.maxGradient, state === 4 ? randomValue : time, target);
  if (state === 2) {
    serializedColor(gradient.minColor, target);
    serializedColor(gradient.maxColor, GRADIENT_SCRATCH);
    target.r = lerp(target.r, GRADIENT_SCRATCH.r, randomValue);
    target.g = lerp(target.g, GRADIENT_SCRATCH.g, randomValue);
    target.b = lerp(target.b, GRADIENT_SCRATCH.b, randomValue);
    target.a = lerp(target.a, GRADIENT_SCRATCH.a, randomValue);
    return target;
  }
  if (state === 3) {
    evaluateGradient(gradient.minGradient, time, target);
    evaluateGradient(gradient.maxGradient, time, GRADIENT_SCRATCH);
    target.r = lerp(target.r, GRADIENT_SCRATCH.r, randomValue);
    target.g = lerp(target.g, GRADIENT_SCRATCH.g, randomValue);
    target.b = lerp(target.b, GRADIENT_SCRATCH.b, randomValue);
    target.a = lerp(target.a, GRADIENT_SCRATCH.a, randomValue);
    return target;
  }
  return serializedColor(ZERO_COLOR, target);
}

