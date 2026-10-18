import { nativeParticleNoiseVelocity, type NativeNoiseCurveSampler, type NativeParticleNoiseParameters, type NativeParticleNoiseField } from "./NativeParticleNoise";

export interface NativeParticleNoiseSnapshot {
  /** Original enum: Local0 / World1. Custom2 requires its own original space transform. */
  simulationSpace: 0 | 1;
  lifecycleSeed: number;
  tickAge: number;
  position: readonly [number, number, number];
  previousBaseline: readonly [number, number, number];
}

/** One real particle's fixed-tick Noise state. World particles retain the born world pose. */
export class NativeParticleNoiseOwner {
  private readonly position: [number, number, number];
  private readonly previousBaseline: [number, number, number];
  private readonly baselineScratch: [number, number, number] = [0, 0, 0];
  private readonly noiseScratch: [number, number, number] = [0, 0, 0];
  private tickAge = 0;

  constructor(
    readonly simulationSpace: 0 | 1,
    readonly lifecycleSeed: number,
    readonly lifetime: number,
    private readonly parameters: NativeParticleNoiseParameters,
    private readonly sampleCurve: NativeNoiseCurveSampler,
    /** Born position is already in actual simulation space: World1 uses the emitter's birth TRS once. */
    bornPosition: readonly [number, number, number],
    /** Returns the original noise-free motion in that same space; World must use the saved birth transform. */
    private readonly baselinePositionAt: (age: number, target: [number, number, number]) => void,
    /** Shared emitter field state, advanced by its real system owner before this particle tick. */
    private readonly systemField: NativeParticleNoiseField,
    private readonly fixedStepSeconds = 1 / 60,
  ) {
    if ((simulationSpace !== 0 && simulationSpace !== 1) || !Number.isInteger(lifecycleSeed) ||
        lifecycleSeed < 0 || lifecycleSeed > 0xffffffff || !Number.isFinite(lifetime) || lifetime <= 0 ||
        !Number.isFinite(fixedStepSeconds) || fixedStepSeconds <= 0 || !bornPosition.every(Number.isFinite))
      throw new Error("Invalid authored particle Noise lifecycle");
    this.position = [...bornPosition];
    this.previousBaseline = [...bornPosition];
  }

  /** Called with actual simulation age at a fixed tick; render-only samples never advance or re-roll it. */
  advance(age: number): void {
    if (!Number.isFinite(age) || age < this.tickAge) throw new Error("Particle Noise requires an explicit snapshot restore for backward time");
    const maximum = Math.min(age, this.lifetime);
    while (this.tickAge + this.fixedStepSeconds <= maximum) {
      const nextAge = this.tickAge + this.fixedStepSeconds;
      this.baselinePositionAt(nextAge, this.baselineScratch);
      for (let axis = 0; axis < 3; axis++) {
        if (!Number.isFinite(this.baselineScratch[axis])) throw new Error("Non-finite authored particle base motion");
        this.position[axis] += this.baselineScratch[axis]! - this.previousBaseline[axis]!;
        this.previousBaseline[axis] = this.baselineScratch[axis]!;
      }
      nativeParticleNoiseVelocity(this.parameters, this.position, nextAge, this.lifetime,
        this.lifecycleSeed, this.sampleCurve, this.noiseScratch, this.systemField);
      for (let axis = 0; axis < 3; axis++) this.position[axis] += this.noiseScratch[axis]! * this.fixedStepSeconds;
      this.tickAge = nextAge;
    }
  }
  readPosition(target: [number, number, number]): void {
    target[0] = this.position[0]; target[1] = this.position[1]; target[2] = this.position[2];
  }
  snapshot(): NativeParticleNoiseSnapshot {
    return { simulationSpace: this.simulationSpace, lifecycleSeed: this.lifecycleSeed, tickAge: this.tickAge,
      position: [...this.position], previousBaseline: [...this.previousBaseline] };
  }
  restore(snapshot: NativeParticleNoiseSnapshot): void {
    if (snapshot.simulationSpace !== this.simulationSpace || snapshot.lifecycleSeed !== this.lifecycleSeed ||
        !Number.isFinite(snapshot.tickAge) || snapshot.tickAge < 0 || snapshot.tickAge > this.lifetime ||
        !snapshot.position.every(Number.isFinite) || !snapshot.previousBaseline.every(Number.isFinite))
      throw new Error("Particle Noise snapshot belongs to another lifecycle or space");
    this.tickAge = snapshot.tickAge;
    for (let axis = 0; axis < 3; axis++) {
      this.position[axis] = snapshot.position[axis]!;
      this.previousBaseline[axis] = snapshot.previousBaseline[axis]!;
    }
  }
}
