/** Independently authored coherent gradient field, driven by the original NoiseModule parameters. */
export interface NativeParticleNoiseParameters {
  quality: 0 | 1 | 2;
  frequency: number;
  octaves: number;
  octaveMultiplier: number;
  octaveScale: number;
  damping: boolean;
  separateAxes: boolean;
  remapEnabled: boolean;
  strength: readonly [unknown, unknown, unknown];
  remap: readonly [unknown, unknown, unknown];
  scrollSpeed: unknown;
  positionAmount: unknown;
}
export interface NativeParticleNoiseField { scrollOffset: number; seed: number }
export type NativeNoiseCurveSampler = (curve: unknown, normalizedAge: number, random: number) => number;

const mix = (value: number): number => {
  let x = value | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
};
const fade = (value: number): number => value * value * value * (value * (value * 6 - 15) + 10);
const lerp = (a: number, b: number, value: number): number => a + (b - a) * value;
const gradient = (x: number, y: number, z: number, ix: number, iy: number, iz: number, seed: number, dimensions: number): number => {
  const h = mix(seed ^ Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791));
  if (dimensions === 1) return (h & 1 ? x : -x);
  if (dimensions === 2) {
    switch (h & 7) {
      case 0: return x; case 1: return -x; case 2: return y; case 3: return -y;
      case 4: return (x + y) * Math.SQRT1_2; case 5: return (x - y) * Math.SQRT1_2;
      case 6: return (-x + y) * Math.SQRT1_2; default: return (-x - y) * Math.SQRT1_2;
    }
  }
  const axis = h % 3, a = axis === 0 ? x : axis === 1 ? y : z;
  const b = axis === 0 ? y : axis === 1 ? z : x;
  return ((h & 4 ? -a : a) + (h & 8 ? -b : b)) * Math.SQRT1_2;
};

function field(x: number, y: number, z: number, seed: number, dimensions: number): number {
  const ix = Math.floor(x), iy = dimensions > 1 ? Math.floor(y) : 0, iz = dimensions > 2 ? Math.floor(z) : 0;
  const dx = x - ix, dy = dimensions > 1 ? y - iy : 0, dz = dimensions > 2 ? z - iz : 0;
  const u = fade(dx), v = fade(dy), w = fade(dz);
  const lowerX = lerp(gradient(dx, dy, dz, ix, iy, iz, seed, dimensions),
    gradient(dx - 1, dy, dz, ix + 1, iy, iz, seed, dimensions), u);
  if (dimensions === 1) return lowerX;
  const low = lerp(lowerX, lerp(gradient(dx, dy - 1, dz, ix, iy + 1, iz, seed, dimensions),
    gradient(dx - 1, dy - 1, dz, ix + 1, iy + 1, iz, seed, dimensions), u), v);
  if (dimensions < 3) return low;
  const high = lerp(lerp(gradient(dx, dy, dz - 1, ix, iy, iz + 1, seed, dimensions),
    gradient(dx - 1, dy, dz - 1, ix + 1, iy, iz + 1, seed, dimensions), u),
    lerp(gradient(dx, dy - 1, dz - 1, ix, iy + 1, iz + 1, seed, dimensions),
      gradient(dx - 1, dy - 1, dz - 1, ix + 1, iy + 1, iz + 1, seed, dimensions), u), v);
  return lerp(low, high, w);
}

/** Noise velocity in the original simulation space. The particle owner integrates it at its real fixed ticks. */
export function nativeParticleNoiseVelocity(
  parameters: NativeParticleNoiseParameters,
  position: readonly [number, number, number],
  age: number,
  lifetime: number,
  lifecycleSeed: number,
  sampleCurve: NativeNoiseCurveSampler,
  target: [number, number, number],
  systemField: NativeParticleNoiseField,
): void {
  if (!Number.isFinite(position[0]) || !Number.isFinite(position[1]) || !Number.isFinite(position[2]) ||
      !Number.isFinite(age) || !Number.isFinite(lifetime) || !Number.isFinite(parameters.frequency) ||
      !Number.isFinite(parameters.octaveMultiplier) || !Number.isFinite(parameters.octaveScale) ||
      age < 0 || lifetime <= 0 || parameters.frequency < 0 || !Number.isInteger(parameters.octaves) ||
      parameters.octaves < 1 || parameters.octaves > 16 || !Number.isInteger(parameters.quality) || parameters.quality < 0 || parameters.quality > 2 ||
      !Number.isFinite(systemField.scrollOffset) || !Number.isInteger(systemField.seed) || systemField.seed < 0 || systemField.seed > 0xffffffff)
    throw new Error("Invalid authored native particle Noise parameters");
  const normalizedAge = Math.max(0, Math.min(1, age / lifetime));
  const scroll = systemField.scrollOffset;
  const amount = sampleCurve(parameters.positionAmount, normalizedAge, mix(lifecycleSeed ^ Math.imul(5, 0x9e3779b9)) / 0x100000000);
  const dimensions = parameters.quality + 1;
  for (let axis = 0; axis < 3; axis++) {
    const random = mix(lifecycleSeed ^ Math.imul((parameters.separateAxes ? axis : 0) + 1, 0x9e3779b9)) / 0x100000000;
    let frequency = parameters.frequency, amplitude = 1, sum = 0, normalization = 0;
    for (let octave = 0; octave < parameters.octaves; octave++) {
      sum += field(position[0] * frequency + scroll, position[1] * frequency + scroll,
        position[2] * frequency + scroll, mix(systemField.seed ^ Math.imul(axis + 1, 0x85ebca6b)), dimensions) * amplitude;
      normalization += amplitude;
      amplitude *= parameters.octaveMultiplier;
      frequency *= parameters.octaveScale;
    }
    let noise = normalization ? sum / normalization : 0;
    if (parameters.remapEnabled)
      noise = sampleCurve(parameters.remap[parameters.separateAxes ? axis : 0], (noise + 1) / 2, random);
    let strength = sampleCurve(parameters.strength[parameters.separateAxes ? axis : 0], normalizedAge, random);
    if (parameters.damping && parameters.frequency > 0) strength /= parameters.frequency;
    target[axis] = noise * strength * amount;
    if (!Number.isFinite(target[axis])) throw new Error("Non-finite authored native particle Noise velocity");
  }
}
