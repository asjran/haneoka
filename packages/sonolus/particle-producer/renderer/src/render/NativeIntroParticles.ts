import { Matrix4, Quaternion, Vector3 } from "three";
import { evaluateNativeMinMaxCurve, evaluateNativeMinMaxGradient, nativeParticleRandom, readNativeParticleSystem, type NativeParticleSystemData } from "./ParticleLayer";
import { nativeParticleNoiseVelocity, type NativeParticleNoiseParameters, type NativeParticleNoiseField } from "./NativeParticleNoise";

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid intro particle module");
  return value as Record<string, unknown>;
};
const finite = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid intro particle number");
  return value;
};
const vector = (value: unknown): Vector3 => {
  const data = object(value); return new Vector3(finite(data.x), finite(data.y), finite(data.z));
};
const enabled = (value: unknown): boolean => object(value).enabled === true;
const random = (seed: number, channel: number): number => nativeParticleRandom((seed + Math.imul(channel, 0x9e3779b9)) >>> 0);
const curve = (value: unknown, time: number, seed: number, channel: number): number => evaluateNativeMinMaxCurve(value, time, random(seed, channel));

export interface NativeIntroParticle {
  seed: number;
  age: number;
  lifetime: number;
  position: [number, number, number];
  velocity: [number, number, number];
  birthRotation: Quaternion;
  birthScale: Vector3;
  size: number;
  rotation: number;
  colour: [number, number, number, number];
}
export interface NativeIntroEmitterSnapshot {
  seed: number;
  sequence: number;
  active: boolean;
  time: number;
  carryTime: number;
  carryDistance: number;
  noiseScrollOffset: number;
  sharedFieldSeed: number;
  previousPosition: [number, number, number];
  particles: ReadonlyArray<NativeIntroParticle>;
}

/** Real play-on-awake owner for the authored lane-in star systems. Time is simulation time. */
export class NativeIntroEmitter {
  readonly particles: NativeIntroParticle[] = [];
  readonly system: NativeParticleSystemData;
  private readonly initial: Record<string, unknown>;
  private readonly shape: Record<string, unknown>;
  private readonly emission: Record<string, unknown>;
  private readonly velocity: Record<string, unknown>;
  private readonly size: Record<string, unknown>;
  private readonly noise: NativeParticleNoiseParameters;
  private seed = 0;
  private sequence = 0;
  private active = false;
  private time = 0;
  private carryTime = 0;
  private carryDistance = 0;
  private readonly noiseField: NativeParticleNoiseField = { scrollOffset: 0, seed: 0 };
  private readonly previousPosition = new Vector3();
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly scale = new Vector3();
  private readonly motion = new Vector3();
  private readonly noiseScratch: [number, number, number] = [0, 0, 0];
  private readonly shapeRotation: Quaternion;
  private readonly shapeScale: Vector3;
  private readonly shapePosition: Vector3;
  private readonly shapeDirection = new Vector3();
  private readonly radius: number;
  private readonly arc: number;
  private readonly radiusThickness: number;

  constructor(value: unknown, private readonly nextLifecycleSeed: () => number) {
    const system = readNativeParticleSystem(value);
    if (!system || system.simulationSpace !== 1 || system.scalingMode !== 0 || system.looping)
      throw new Error("Unsupported intro particle simulation contract");
    this.system = system;
    const raw = system.raw;
    this.initial = object(raw.InitialModule); this.shape = object(raw.ShapeModule);
    this.emission = object(raw.EmissionModule); this.velocity = object(raw.VelocityModule); this.size = object(raw.SizeModule);
    const n = object(raw.NoiseModule);
    if (this.shape.type !== 10 || this.initial.rotation3D !== false || this.initial.size3D !== false ||
        this.size.separateAxes !== false || this.velocity.inWorldSpace !== false || raw.prewarm !== false ||
        finite(this.emission.m_BurstCount) !== 0 || finite(this.shape.randomDirectionAmount) !== 0 ||
        finite(this.shape.sphericalDirectionAmount) !== 0 || finite(this.shape.randomPositionAmount) !== 0)
      throw new Error("Unsupported authored intro particle shape/modules");
    const consumedModules = new Set(["InitialModule", "ShapeModule", "EmissionModule", "VelocityModule", "NoiseModule", "SizeModule"]);
    for (const [name, value] of Object.entries(raw))
      if (name.endsWith("Module") && !consumedModules.has(name) && enabled(value))
        throw new Error(`Unsupported intro particle module: ${name}`);
    const constant = (value: unknown, expected: number): boolean => {
      const c = object(value);
      return (c.minMaxState === 0 || c.minMaxState === 3) && c.scalar === expected && c.minScalar === expected &&
        !Object.is(c.scalar, -0) && !Object.is(c.minScalar, -0);
    };
    for (const name of ["orbitalX", "orbitalY", "orbitalZ", "orbitalOffsetX", "orbitalOffsetY", "orbitalOffsetZ", "radial"])
      if (!constant(this.velocity[name], 0)) throw new Error("Unsupported intro orbital motion");
    if (!constant(this.velocity.speedModifier, 1) || !constant(this.initial.gravityModifier, 0) ||
        !constant(this.initial.startRotation, 0) || !constant(raw.startDelay, 0) ||
        !constant(n.rotationAmount, 0) || !constant(n.sizeAmount, 0) || n.enabled !== true ||
        this.emission.enabled !== true || this.velocity.enabled !== true || this.shape.enabled !== true || this.size.enabled !== true)
      throw new Error("Unsupported intro speed, gravity, rotation or lifecycle modules");
    this.noise = {
      quality: finite(n.quality) as 0 | 1 | 2, frequency: finite(n.frequency), octaves: finite(n.octaves),
      octaveMultiplier: finite(n.octaveMultiplier), octaveScale: finite(n.octaveScale), damping: n.damping === true,
      separateAxes: n.separateAxes === true, remapEnabled: n.remapEnabled === true,
      strength: [n.strength, n.strengthY, n.strengthZ], remap: [n.remap, n.remapY, n.remapZ],
      scrollSpeed: n.scrollSpeed, positionAmount: n.positionAmount,
    };
    const radius = object(this.shape.radius), arc = object(this.shape.arc);
    if (radius.mode !== 0 || arc.mode !== 0 || finite(radius.spread) !== 0 || finite(arc.spread) !== 0)
      throw new Error("Unsupported intro Circle emission sweep");
    this.radius = finite(radius.value); this.arc = finite(arc.value) * Math.PI / 180;
    this.radiusThickness = finite(this.shape.radiusThickness);
    if (this.radius < 0 || this.radiusThickness < 0 || this.radiusThickness > 1 || this.arc < 0 || this.arc > 2 * Math.PI)
      throw new Error("Invalid intro Circle geometry");
    this.shapeScale = vector(this.shape.m_Scale); this.shapePosition = vector(this.shape.m_Position);
    const angles = vector(this.shape.m_Rotation).multiplyScalar(Math.PI / 180);
    // Unity Euler uses Z-X-Y composition.
    this.shapeRotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angles.y)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), angles.x))
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), angles.z));
  }

  tick(active: boolean, emitterWorld: Matrix4, gameDelta: number): void {
    if (!Number.isFinite(gameDelta) || gameDelta < 0) throw new Error("Invalid intro particle tick");
    emitterWorld.decompose(this.position, this.rotation, this.scale);
    if (active && !this.active) {
      this.particles.length = 0; this.time = 0; this.sequence = 0; this.carryTime = 0; this.carryDistance = 0; this.noiseField.scrollOffset = 0;
      const rawSeed = this.system.raw.autoRandomSeed === true ? this.nextLifecycleSeed() : this.system.raw.randomSeed;
      this.seed = finite(rawSeed) >>> 0;
      this.previousPosition.copy(this.position);
    }
    this.active = active;
    if (!active) { this.particles.length = 0; this.previousPosition.copy(this.position); return; }
    const delta = gameDelta * this.system.simulationSpeed;
    if (delta === 0) return;
    const emissionDelta = Math.max(0, Math.min(delta, this.system.length - this.time));
    const normalized = Math.min(1, this.time / this.system.length);
    // Noise scroll belongs to the emitter: every born/live particle sees one coherent system field.
    this.noiseField.scrollOffset += curve(this.noise.scrollSpeed, normalized, this.seed, 15) * delta;
    const rateTime = Math.max(0, curve(this.emission.rateOverTime, normalized, this.seed, 1));
    const rateDistance = Math.max(0, curve(this.emission.rateOverDistance, normalized, this.seed, 2));
    const timeBefore = this.carryTime;
    this.carryTime += emissionDelta * rateTime;
    const distanceBefore = this.carryDistance;
    this.carryDistance += this.position.distanceTo(this.previousPosition) * rateDistance * (emissionDelta / delta);
    const births: number[] = [];
    for (let i = 1; i <= Math.floor(this.carryTime); i++) births.push(rateTime ? (i - timeBefore) / rateTime : 0);
    const distanceTotal = this.carryDistance - distanceBefore;
    for (let i = 1; i <= Math.floor(this.carryDistance); i++) births.push(distanceTotal ? emissionDelta * (i - distanceBefore) / distanceTotal : 0);
    this.carryTime -= Math.floor(this.carryTime); this.carryDistance -= Math.floor(this.carryDistance);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i]!; this.advance(particle, delta);
      if (particle.age >= particle.lifetime) this.particles.splice(i, 1);
    }
    for (const offset of births.sort((a, b) => a - b)) {
      if (this.particles.length >= this.system.maxParticles) break;
      const particle = this.birth(emitterWorld, (this.time + offset) / this.system.length, offset / delta);
      this.advance(particle, Math.max(0, delta - offset));
      if (particle.age < particle.lifetime) this.particles.push(particle);
    }
    this.time += delta; this.previousPosition.copy(this.position);
  }

  private birth(emitterWorld: Matrix4, normalized: number, birthFraction: number): NativeIntroParticle {
    const seed = (this.seed + Math.imul(++this.sequence, 0x85ebca6b)) >>> 0;
    const angle = random(seed, 3) * this.arc, inner = 1 - this.radiusThickness;
    const radius = this.radius * Math.sqrt(inner * inner + (1 - inner * inner) * random(seed, 4));
    this.shapeDirection.set(Math.cos(angle), Math.sin(angle), 0);
    this.motion.copy(this.shapeDirection).multiplyScalar(radius)
      .multiply(this.shapeScale).applyQuaternion(this.shapeRotation).add(this.shapePosition).applyMatrix4(emitterWorld);
    // World emission retains the sub-frame emitter origin and its birth linear transform.
    this.motion.sub(this.position).addScaledVector(this.previousPosition, 1 - birthFraction).addScaledVector(this.position, birthFraction);
    const position: [number, number, number] = [this.motion.x, this.motion.y, this.motion.z];
    this.motion.copy(this.shapeDirection).multiplyScalar(curve(this.initial.startSpeed, normalized, seed, 6))
      .applyQuaternion(this.shapeRotation).multiply(this.scale).applyQuaternion(this.rotation);
    const colour = evaluateNativeMinMaxGradient(this.initial.startColor, normalized, random(seed, 7));
    return { seed, age: 0, lifetime: Math.max(Number.EPSILON, curve(this.initial.startLifetime, normalized, seed, 8)),
      position, velocity: [this.motion.x, this.motion.y, this.motion.z], birthRotation: this.rotation.clone(), birthScale: this.scale.clone(),
      size: curve(this.initial.startSize, normalized, seed, 9),
      rotation: curve(this.initial.startRotation, normalized, seed, 10), colour: [colour.r, colour.g, colour.b, colour.a] };
  }
  private advance(particle: NativeIntroParticle, delta: number): void {
    const step = Math.min(delta, particle.lifetime - particle.age);
    if (step <= 0) return;
    const normalized = Math.min(1, (particle.age + step * 0.5) / particle.lifetime);
    this.motion.set(curve(this.velocity.x, normalized, particle.seed, 11), curve(this.velocity.y, normalized, particle.seed, 11),
      curve(this.velocity.z, normalized, particle.seed, 11)).multiply(particle.birthScale).applyQuaternion(particle.birthRotation)
      .multiplyScalar(curve(this.velocity.speedModifier, normalized, particle.seed, 12));
    particle.velocity[1] -= 9.81 * curve(this.initial.gravityModifier, normalized, particle.seed, 13) * step;
    nativeParticleNoiseVelocity(this.noise, particle.position, particle.age + step, particle.lifetime,
      particle.seed, evaluateNativeMinMaxCurve, this.noiseScratch, this.noiseField);
    for (let axis = 0; axis < 3; axis++) particle.position[axis] +=
      (particle.velocity[axis]! + this.motion.getComponent(axis) + this.noiseScratch[axis]!) * step;
    particle.age += step;
  }
  particleSize(particle: NativeIntroParticle): number {
    return particle.size * curve(this.size.curve, particle.age / particle.lifetime, particle.seed, 14);
  }
  snapshot(): NativeIntroEmitterSnapshot {
    return { seed: this.seed, sequence: this.sequence, active: this.active, time: this.time, carryTime: this.carryTime,
      carryDistance: this.carryDistance, noiseScrollOffset: this.noiseField.scrollOffset, sharedFieldSeed: this.noiseField.seed, previousPosition: this.previousPosition.toArray() as [number, number, number],
      particles: this.particles.map(p => ({ ...p, position: [...p.position], velocity: [...p.velocity], colour: [...p.colour], birthRotation: p.birthRotation.clone(), birthScale: p.birthScale.clone() })) };
  }
  restore(snapshot: NativeIntroEmitterSnapshot): void {
    this.seed = snapshot.seed; this.sequence = snapshot.sequence; this.active = snapshot.active; this.time = snapshot.time;
    this.carryTime = snapshot.carryTime; this.carryDistance = snapshot.carryDistance;
    this.noiseField.scrollOffset = snapshot.noiseScrollOffset; this.noiseField.seed = snapshot.sharedFieldSeed; this.previousPosition.fromArray(snapshot.previousPosition);
    this.particles.length = 0;
    this.particles.push(...snapshot.particles.map(p => ({ ...p, position: [...p.position] as [number, number, number],
      velocity: [...p.velocity] as [number, number, number], colour: [...p.colour] as [number, number, number, number], birthRotation: p.birthRotation.clone(), birthScale: p.birthScale.clone() })));
  }
  dispose(): void { this.particles.length = 0; this.active = false; }
}
