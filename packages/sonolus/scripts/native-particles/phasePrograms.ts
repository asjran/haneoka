import type { ParticleData } from "./merge.ts";
import type { TrajectoryParticle } from "./trajectory.ts";

type Json = Record<string, unknown>;
interface Group {
  count: number;
  particles: TrajectoryParticle[];
}
export interface NativePhaseProgram {
  name: string;
  buckets: Array<{ start: number; end: number }>;
}

export const nativePhaseProgramName = (base: string, bucket: number) => (bucket === 0 ? base : `${base} B${bucket}`);

/** Assign whole native intervals to their start bucket; their easing is unchanged. */
export function partitionNativeSourcePrograms(source: ParticleData, prefixes: readonly string[], bucketCount: number) {
  if (!Number.isInteger(bucketCount) || bucketCount < 2 || bucketCount > 64)
    throw new Error("Invalid native bucket count");
  const semantic = (name: string) => {
    const prefix = prefixes.find((prefix) => name.startsWith(prefix + " "));
    return prefix ? name.replace(prefix, "Our Notes Native") : undefined;
  };
  const index = new Map<string, NativePhaseProgram>();
  const selected = source.effects.filter(
    (effect) => String(effect.name).endsWith(" P0") && semantic(String(effect.name)),
  );
  for (const effect of selected) {
    const name = semantic(String(effect.name))!;
    let program = index.get(name);
    if (!program)
      index.set(
        name,
        (program = {
          name,
          buckets: Array.from({ length: bucketCount }, (_, bucket) => ({
            start: bucket / bucketCount,
            end: bucket / bucketCount,
          })),
        }),
      );
    for (const group of effect.groups as Group[]) {
      if (
        group.count !== 1 ||
        group.particles.some((particle) =>
          ["x", "y", "w", "h", "r", "a"].some((channel) =>
            [particle[channel as "x"].from, particle[channel as "x"].to].some((expression) =>
              Object.keys(expression).some((key) => key !== "c"),
            ),
          ),
        )
      )
        throw new Error(`Native programs require fixed Source trajectories: ${name}`);
      for (const particle of group.particles) {
        const bucket = Math.min(bucketCount - 1, Math.floor(particle.start * bucketCount));
        program.buckets[bucket]!.end = Math.max(program.buckets[bucket]!.end, particle.start + particle.duration);
      }
    }
  }
  const reports: Array<{
    name: string;
    definitions: number;
    programs: number;
    serialTimeIntegralBefore: number;
    serialTimeIntegralAfter: number;
    maximumConcurrentPrograms: number;
  }> = [];
  const effects = source.effects.flatMap((effect) => {
    const name = String(effect.name),
      key = semantic(name);
    if (!name.endsWith(" P0") || !key) return [effect];
    const program = index.get(key)!;
    const groups = effect.groups as Group[];
    const outputs: Json[] = [];
    let serialAfter = 0;
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      const { start, end } = program.buckets[bucket]!;
      const duration = end - start;
      if (duration <= 0) continue;
      const partition = groups.flatMap((group) => {
        const particles = group.particles
          .filter((particle) => Math.min(bucketCount - 1, Math.floor(particle.start * bucketCount)) === bucket)
          .map((particle) => ({
            ...particle,
            start: (particle.start - start) / duration,
            duration: particle.duration / duration,
          }));
        return particles.length ? [{ ...group, particles }] : [];
      });
      const definitions = partition.reduce((sum, group) => sum + group.particles.length, 0);
      if (!definitions) continue;
      serialAfter += definitions * duration;
      outputs.push({ ...effect, name: nativePhaseProgramName(name, bucket), groups: partition });
    }
    const definitions = groups.reduce((sum, group) => sum + group.particles.length, 0);
    const boundaries = program.buckets.flatMap((bucket) => [bucket.start, bucket.end]);
    const maximumConcurrentPrograms = Math.max(
      0,
      ...boundaries.map((time) => program.buckets.filter((bucket) => time >= bucket.start && time < bucket.end).length),
    );
    reports.push({
      name,
      definitions,
      programs: outputs.length,
      serialTimeIntegralBefore: definitions,
      serialTimeIntegralAfter: serialAfter,
      maximumConcurrentPrograms,
    });
    return outputs;
  });
  return {
    data: { ...source, effects },
    abi: {
      version: 1,
      bucketCount,
      clock: "normalized source clip progress; loop tails may end after1",
      capability: "Our Notes Native Normal W4 P0 B1",
      zeroBucketName: "legacy P0 name",
      programs: [...index.values()],
    },
    report: reports,
  };
}
