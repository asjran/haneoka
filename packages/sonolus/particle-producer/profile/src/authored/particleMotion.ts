import { evaluateNativeMinMaxCurve } from "./unityParticleMath.js";

type RecordData = Record<string, unknown>;
const record = (value: unknown): RecordData | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordData) : undefined;
const finite = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Intl formal TimeManager.Maximum Particle Timestep. */
export const OUR_NOTES_MAXIMUM_PARTICLE_TIMESTEP = 0.029999999329447746;

export interface NativeParticleMotionSource {
  readonly velocity: RecordData | undefined;
  readonly limiter: RecordData | undefined;
  readonly gravity: unknown;
  readonly zeroOrbit: boolean;
  readonly maximumLifetime: number;
}

export function readNativeParticleMotionSource(raw: RecordData): NativeParticleMotionSource {
  const initial = record(raw.InitialModule);
  const velocity = record(raw.VelocityModule);
  const zero = (value: unknown): boolean => {
    const curve = record(value);
    return (
      !!curve &&
      (curve.minMaxState === 0 || curve.minMaxState === 3) &&
      curve.scalar === 0 &&
      !Object.is(curve.scalar, -0) &&
      curve.minScalar === 0 &&
      !Object.is(curve.minScalar, -0)
    );
  };
  return {
    velocity,
    zeroOrbit:
      !!velocity &&
      ["orbitalOffsetX", "orbitalOffsetY", "orbitalOffsetZ", "orbitalX", "orbitalY", "orbitalZ", "radial"].every(
        (key) => zero(velocity[key]),
      ),
    limiter: record(raw.ClampVelocityModule),
    gravity: initial?.gravityModifier,
    maximumLifetime: Math.max(
      0,
      evaluateNativeMinMaxCurve(initial?.startLifetime, 0, 0),
      evaluateNativeMinMaxCurve(initial?.startLifetime, 0, 1),
    ),
  };
}

export interface NativeParticleMotionState {
  birthTime: number;
  simulationTime: number;
  age: number;
  lifetime: number;
  curveRandom: number;
  x: number;
  y: number;
  z: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
}

/** One native update, before lifetime advancement. The caller supplies newborn fractional dt. */
export function advanceNativeParticleMotion(
  source: NativeParticleMotionSource,
  state: NativeParticleMotionState,
  delta: number,
): void {
  if (delta <= 0) return;
  const normalized = clamp(state.age / Math.max(Number.EPSILON, state.lifetime));
  const velocity = source.velocity;
  const limiter = source.limiter;
  const random = state.curveRandom;
  const curve = (value: unknown): number => evaluateNativeMinMaxCurve(value, normalized, random);
  let vx = 0,
    vy = 0,
    vz = 0;
  if (velocity?.enabled === true) {
    vx = curve(velocity.x);
    vy = curve(velocity.y);
    vz = curve(velocity.z);
    if (source.zeroOrbit) {
      const relativeX = state.x - 0,
        relativeY = state.y - 0,
        relativeZ = state.z - 0;
      vx += 0 * relativeZ - 0 * relativeY;
      vy += 0 * relativeX - 0 * relativeZ;
      vz += 0 * relativeY - 0 * relativeX;
      if (
        Math.max(Math.abs(relativeX), Math.abs(relativeY), Math.abs(relativeZ)) > Number.EPSILON ||
        Math.hypot(relativeX, relativeY, relativeZ) > Number.EPSILON
      ) {
        vx += Math.sign(relativeX) * 0;
        vy += Math.sign(relativeY) * 0;
        vz += Math.sign(relativeZ) * 0;
      }
    } else {
      const relativeX = state.x - curve(velocity.orbitalOffsetX);
      const relativeY = state.y - curve(velocity.orbitalOffsetY);
      const relativeZ = state.z - curve(velocity.orbitalOffsetZ);
      const angularX = curve(velocity.orbitalX);
      const angularY = curve(velocity.orbitalY);
      const angularZ = curve(velocity.orbitalZ);
      vx += angularY * relativeZ - angularZ * relativeY;
      vy += angularZ * relativeX - angularX * relativeZ;
      vz += angularX * relativeY - angularY * relativeX;
      const radialLength = Math.hypot(relativeX, relativeY, relativeZ);
      if (radialLength > Number.EPSILON) {
        const radial = curve(velocity.radial);
        vx += (relativeX / radialLength) * radial;
        vy += (relativeY / radialLength) * radial;
        vz += (relativeZ / radialLength) * radial;
      }
    }
    const speedModifier = velocity.speedModifier ? curve(velocity.speedModifier) : 1;
    vx *= speedModifier;
    vy *= speedModifier;
    vz *= speedModifier;
  }
  state.velocityY -= 9.81 * curve(source.gravity) * delta;
  const addedX = vx,
    addedY = vy,
    addedZ = vz;
  vx += state.velocityX;
  vy += state.velocityY;
  vz += state.velocityZ;
  if (limiter?.enabled === true) {
    const dampen = 1 - Math.pow(1 - clamp(finite(limiter.dampen)), Math.abs(delta) * 30);
    if (limiter.separateAxis === true) {
      const limitX = Math.max(0, curve(limiter.x));
      const limitY = Math.max(0, curve(limiter.y));
      const limitZ = Math.max(0, curve(limiter.z));
      vx = Math.sign(vx) * lerp(Math.abs(vx), Math.min(Math.abs(vx), limitX), dampen);
      vy = Math.sign(vy) * lerp(Math.abs(vy), Math.min(Math.abs(vy), limitY), dampen);
      vz = Math.sign(vz) * lerp(Math.abs(vz), Math.min(Math.abs(vz), limitZ), dampen);
    } else {
      const limit = Math.max(0, curve(limiter.magnitude));
      const speed = Math.hypot(vx, vy, vz);
      if (speed > limit && speed > 0) {
        const limitedSpeed = lerp(speed, limit, dampen);
        vx *= limitedSpeed / speed;
        vy *= limitedSpeed / speed;
        vz *= limitedSpeed / speed;
      }
    }
    const drag = Math.max(0, curve(limiter.drag));
    const speed = Math.hypot(vx, vy, vz);
    const dragBySpeed = limiter.multiplyDragByParticleVelocity === true ? speed * speed : 1;
    const dragFactor = speed > 0 ? Math.max(0, speed - drag * dragBySpeed * delta) / speed : 0;
    vx *= dragFactor;
    vy *= dragFactor;
    vz *= dragFactor;
    state.velocityX = vx - addedX;
    state.velocityY = vy - addedY;
    state.velocityZ = vz - addedZ;
  }
  state.x += vx * delta;
  state.y += vy * delta;
  state.z += vz * delta;
  state.age += delta;
  state.simulationTime += delta;
}

export interface NativeParticleMotionFrame {
  readonly from: number;
  readonly to: number;
  readonly step: number;
  readonly steps: number;
}

/** Retains actual frame subdivision only while a source particle can still live. */
export class NativeParticleMotionClock {
  private readonly frames: NativeParticleMotionFrame[] = [];
  private head = 0;
  private frontier = 0;
  private updates = 0;
  private subdivisions = 0;
  private particleSteps = 0;

  constructor(
    private readonly maximumLifetime: number,
    private readonly maximumStep: number,
  ) {}

  reset(): void {
    this.frames.length = 0;
    this.head = 0;
    this.frontier = 0;
  }

  beginFrame(simulationTime: number): void {
    if (simulationTime < this.frontier) throw new RangeError("Particle motion clock moved backwards without reset");
    const delta = simulationTime - this.frontier;
    if (delta <= 0) return;
    const steps = Math.max(1, Math.ceil(delta / this.maximumStep));
    this.frames.push({ from: this.frontier, to: simulationTime, step: delta / steps, steps });
    this.frontier = simulationTime;
    this.updates++;
    this.subdivisions += steps;
  }

  advance(source: NativeParticleMotionSource, state: NativeParticleMotionState): void {
    if (state.simulationTime >= this.frontier) return;
    let frameIndex = this.frames.length - 1;
    if (state.simulationTime < this.frames[frameIndex]!.from) {
      frameIndex = this.head;
      while (frameIndex < this.frames.length && this.frames[frameIndex]!.to <= state.simulationTime) frameIndex++;
    }
    for (; frameIndex < this.frames.length; frameIndex++) {
      const frame = this.frames[frameIndex]!;
      if (state.simulationTime < frame.from) throw new RangeError("Particle motion birth checkpoint expired");
      // A time below frame.to can round up to frame.steps during division.
      // Visit the final subdivision so its exact endpoint closes the frame.
      let stepIndex = Math.min(
        frame.steps - 1,
        Math.max(0, Math.floor((state.simulationTime - frame.from) / frame.step)),
      );
      for (; stepIndex < frame.steps; stepIndex++) {
        const end = stepIndex + 1 === frame.steps ? frame.to : frame.from + (stepIndex + 1) * frame.step;
        const delta = end - state.simulationTime;
        if (delta <= 0) continue;
        advanceNativeParticleMotion(source, state, delta);
        state.simulationTime = end;
        this.particleSteps++;
      }
    }
  }

  endFrame(): void {
    while (this.head < this.frames.length && this.frames[this.head]!.to < this.frontier - this.maximumLifetime)
      this.head++;
    if (this.head > 64 && this.head * 2 > this.frames.length) {
      this.frames.splice(0, this.head);
      this.head = 0;
    }
  }

  getStats(): { frames: number; updates: number; subdivisions: number; particleSteps: number } {
    return {
      frames: this.frames.length - this.head,
      updates: this.updates,
      subdivisions: this.subdivisions,
      particleSteps: this.particleSteps,
    };
  }
}
