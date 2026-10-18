import {
  evaluateNativeMinMaxCurve as curve,
  evaluateNativeMinMaxGradient as gradient,
  nativeParticleRandom as random,
  prepareNativeCurveLuts,
  quantizeParticleColor,
} from "../authored/unityParticleMath.js";
import {
  advanceNativeParticleMotion,
  readNativeParticleMotionSource,
  type NativeParticleMotionState,
} from "../authored/particleMotion.js";
import { eulerZxy, trs } from "../authored/sourceTransform.js";
import type { OurNotesGekisouStagePose } from "./GekisouStage.js";

type Raw = Record<string, any>;
export interface OurNotesStageParticle extends NativeParticleMotionState {
  seed: number;
  bornWorld: Float64Array;
  birthPosition: [number, number, number];
  color: [number, number, number, number];
  size: [number, number, number];
  angle: number;
  rotation: readonly [number, number, number];
  rotationFrame: Float64Array;
  gravityVelocity: [number, number, number];
  gravityPosition: [number, number, number];
}
const transform = (
  matrix: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
  direction = false,
): [number, number, number] => [
  matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + (direction ? 0 : matrix[12]!),
  matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + (direction ? 0 : matrix[13]!),
  matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + (direction ? 0 : matrix[14]!),
];
export { transform as transformGekisouStagePoint };

export function gekisouStageParticleFrame(pose: OurNotesGekisouStagePose, scalingMode: number): Float64Array {
  if (scalingMode === 0) return new Float64Array(pose.world);
  const scale = scalingMode === 1 ? pose.scale : { x: 1, y: 1, z: 1 };
  const frame = trs({ x: pose.world[12]!, y: pose.world[13]!, z: pose.world[14]! }, pose.worldRotation, scale);
  return frame;
}

export function gekisouStageParticlePosition(
  particle: OurNotesStageParticle,
  raw: Raw,
  pose: OurNotesGekisouStagePose,
): [number, number, number] {
  const root = raw.moveWithTransform === 1 ? particle.bornWorld : gekisouStageParticleFrame(pose, raw.scalingMode);
  const origin = transform(root, particle.x, particle.y, particle.z);
  for (let axis = 0; axis < 3; axis++) origin[axis]! += particle.gravityPosition[axis]!;
  return origin;
}

/** Source emission and motion state, advanced by the caller's game update delta. */
export class OurNotesGekisouStageEmitter {
  readonly particles: OurNotesStageParticle[] = [];
  readonly raw: Raw;
  private readonly motion;
  private enabled = false;
  private time = 0;
  private sequence = 0;
  private carryTime = 0;
  private carryDistance = 0;
  private seed = 0;
  private previousPosition: [number, number, number] = [0, 0, 0];
  private readonly bursts = new Set<string>();
  private readonly shapeMatrix: Float64Array;

  constructor(
    raw: unknown,
    private readonly gravity: readonly number[],
    private readonly nextSeed: () => number,
  ) {
    this.raw = raw as Raw;
    prepareNativeCurveLuts(this.raw);
    this.motion = { ...readNativeParticleMotionSource(this.raw), gravity: undefined };
    const shape = this.raw.ShapeModule;
    this.shapeMatrix = trs(shape.m_Position, eulerZxy(shape.m_Rotation), shape.m_Scale);
  }
  reset(): void {
    this.enabled = false;
    this.time = 0;
    this.sequence = 0;
    this.carryTime = this.carryDistance = 0;
    this.bursts.clear();
    this.particles.length = 0;
  }
  tick(pose: OurNotesGekisouStagePose, delta: number): void {
    const position: [number, number, number] = [pose.world[12]!, pose.world[13]!, pose.world[14]!];
    if (!pose.active) {
      this.reset();
      this.previousPosition = position;
      return;
    }
    if (!this.enabled) {
      this.reset();
      this.enabled = true;
      this.previousPosition = position;
      this.seed = this.raw.autoRandomSeed ? this.nextSeed() >>> 0 : this.raw.randomSeed >>> 0;
    }
    if (delta <= 0) return;
    const speed = this.raw.simulationSpeed,
      dt = delta * speed;
    const from = this.time,
      to = from + dt;
    const delay = curve(this.raw.startDelay, 0, random(this.seed));
    const duration = this.raw.lengthInSec;
    const emission = this.raw.EmissionModule;
    const normalized = duration > 0 ? Math.max(0, (from - delay) % duration) / duration : 0;
    const births: number[] = [];
    const end = this.raw.looping ? to : Math.min(to, delay + duration);
    const emissionDelta = Math.max(0, end - Math.max(from, delay));
    if (emission.enabled && emissionDelta > 0) {
      const rate = Math.max(
        0,
        pose.particleValues.get(2883525743) ?? curve(emission.rateOverTime, normalized, random(this.seed + 1)),
      );
      const distanceRate = Math.max(0, curve(emission.rateOverDistance, normalized, random(this.seed + 2)));
      const previousTimeCarry = this.carryTime,
        previousDistanceCarry = this.carryDistance;
      this.carryTime += emissionDelta * rate;
      const distance = Math.hypot(
        position[0] - this.previousPosition[0],
        position[1] - this.previousPosition[1],
        position[2] - this.previousPosition[2],
      );
      const distanceEmission = (distance * distanceRate * emissionDelta) / dt;
      this.carryDistance += distanceEmission;
      for (let count = 1; count <= Math.floor(this.carryTime); count++)
        births.push(Math.max(from, delay) + (count - previousTimeCarry) / rate);
      for (let count = 1; count <= Math.floor(this.carryDistance); count++)
        births.push(Math.max(from, delay) + (emissionDelta * (count - previousDistanceCarry)) / distanceEmission);
      this.carryTime -= Math.floor(this.carryTime);
      this.carryDistance -= Math.floor(this.carryDistance);
      const firstCycle = this.raw.looping ? Math.max(0, Math.floor((from - delay) / duration)) : 0;
      const lastCycle = this.raw.looping ? Math.max(0, Math.floor((end - delay) / duration)) : 0;
      for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
        for (let index = 0; index < emission.m_BurstCount; index++) {
          const burst = emission.m_Bursts[index];
          for (let repeat = 0; repeat < Math.max(1, burst.cycleCount); repeat++) {
            const born = delay + cycle * duration + burst.time + repeat * burst.repeatInterval;
            const key = `${cycle}:${index}:${repeat}`;
            if (born < from || born > end || this.bursts.has(key)) continue;
            this.bursts.add(key);
            if (random(this.seed + cycle + index + 8) > burst.probability) continue;
            const count = Math.max(0, Math.round(curve(burst.countCurve, normalized, random(this.seed + index + 9))));
            for (let i = 0; i < count; i++) births.push(born);
          }
        }
      }
    }
    for (let index = this.particles.length - 1; index >= 0; index--) {
      const particle = this.particles[index]!;
      this.advance(particle, dt);
      if (particle.age >= particle.lifetime) this.particles.splice(index, 1);
    }
    for (const born of births.sort((a, b) => a - b)) {
      if (this.particles.length >= this.raw.InitialModule.maxNumParticles) break;
      const particle = this.birth(pose, born, normalized, Math.max(0, Math.min(1, (born - from) / dt)));
      this.advance(particle, Math.max(0, to - born));
      if (particle.age < particle.lifetime) this.particles.push(particle);
    }
    this.time = to;
    this.previousPosition = position;
  }
  private birth(
    pose: OurNotesGekisouStagePose,
    born: number,
    normalized: number,
    fraction: number,
  ): OurNotesStageParticle {
    const raw = this.raw,
      initial = raw.InitialModule,
      shape = raw.ShapeModule;
    const seed = (this.seed + Math.imul(++this.sequence, 0x85ebca6b)) >>> 0;
    const sample = (value: unknown, channel: number) => curve(value, normalized, random(seed + channel));
    let position: [number, number, number] = [0, 0, 0],
      direction: [number, number, number] = [0, 0, 0];
    if (shape.enabled) {
      if (shape.type === 12) {
        position = transform(this.shapeMatrix, shape.radius.value * (2 * random(seed + 3) - 1), 0, 0);
        direction = transform(this.shapeMatrix, 0, 1, 0, true);
      } else if (shape.type === 10) {
        const angle = (random(seed + 3) * shape.arc.value * Math.PI) / 180;
        const inner = 1 - shape.radiusThickness;
        const radius = shape.radius.value * Math.sqrt(inner * inner + (1 - inner * inner) * random(seed + 5));
        position = transform(this.shapeMatrix, Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
        direction = transform(this.shapeMatrix, Math.cos(angle), Math.sin(angle), 0, true);
      } else throw new Error(`Unsupported stage particle shape: ${shape.type}`);
    }
    const color = gradient(initial.startColor, normalized, random(seed + 7));
    const alpha = pose.particleValues.get(2007035361);
    if (alpha !== undefined) color.a = alpha;
    quantizeParticleColor(color);
    const flip = random(seed + 15) < initial.randomizeRotationDirection ? -1 : 1;
    const rotation = [
      initial.rotation3D ? sample(initial.startRotationX, 13) * flip : 0,
      initial.rotation3D ? sample(initial.startRotationY, 14) * flip : 0,
      sample(initial.startRotation, 12) * flip,
    ] as const;
    const toDegrees = -180 / Math.PI;
    const rotationFrame = trs(
      { x: 0, y: 0, z: 0 },
      eulerZxy({ x: rotation[0] * toDegrees, y: rotation[1] * toDegrees, z: rotation[2] * toDegrees }),
      { x: 1, y: 1, z: 1 },
    );
    const startSpeed = sample(initial.startSpeed, 6),
      size = sample(initial.startSize, 8);
    const world = gekisouStageParticleFrame(pose, raw.scalingMode);
    for (let axis = 0; axis < 3; axis++)
      world[12 + axis] = this.previousPosition[axis]! * (1 - fraction) + world[12 + axis]! * fraction;
    return {
      seed,
      birthTime: born,
      simulationTime: born,
      age: 0,
      lifetime: sample(initial.startLifetime, 4),
      curveRandom: random(seed + 9),
      x: position[0],
      y: position[1],
      z: position[2],
      velocityX: direction[0] * startSpeed,
      velocityY: direction[1] * startSpeed,
      velocityZ: direction[2] * startSpeed,
      bornWorld: world,
      birthPosition: transform(world, position[0], position[1], position[2]),
      color: [color.r, color.g, color.b, color.a],
      size: [
        size,
        initial.size3D ? sample(initial.startSizeY, 10) : size,
        initial.size3D ? sample(initial.startSizeZ, 11) : size,
      ],
      angle: rotation[2],
      rotation,
      rotationFrame,
      gravityPosition: [0, 0, 0],
      gravityVelocity: [0, 0, 0],
    };
  }
  private advance(particle: OurNotesStageParticle, dt: number): void {
    const modifier = curve(
      this.raw.InitialModule.gravityModifier,
      particle.age / particle.lifetime,
      particle.curveRandom,
    );
    for (let axis = 0; axis < 3; axis++) {
      particle.gravityVelocity[axis]! += this.gravity[axis]! * modifier * dt;
      particle.gravityPosition[axis]! += particle.gravityVelocity[axis]! * dt;
    }
    advanceNativeParticleMotion(this.motion, particle, dt);
  }
  appearance(particle: OurNotesStageParticle): {
    size: [number, number, number];
    color: [number, number, number, number];
  } {
    const t = particle.age / particle.lifetime,
      size = this.raw.SizeModule;
    const factor = size.enabled ? curve(size.curve, t, particle.curveRandom) : 1;
    const color = gradient(
      this.raw.ColorModule.enabled ? this.raw.ColorModule.gradient : undefined,
      t,
      particle.curveRandom,
    );
    color.r *= particle.color[0];
    color.g *= particle.color[1];
    color.b *= particle.color[2];
    color.a *= particle.color[3];
    quantizeParticleColor(color);
    return {
      size: [
        particle.size[0] * factor,
        particle.size[1] * (size.enabled && size.separateAxes ? curve(size.y, t, particle.curveRandom) : factor),
        particle.size[2] * (size.enabled && size.separateAxes ? curve(size.z, t, particle.curveRandom) : factor),
      ],
      color: [color.r, color.g, color.b, color.a],
    };
  }
}
