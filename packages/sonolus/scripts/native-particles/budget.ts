import type { ParticleSample } from "./trace.ts";

type Family = "point" | "star" | "other";

export function sourceParticleFamily(sample: ParticleSample): Family {
  const name = sample.systemName ?? "";
  return name.includes("star") || sample.texture === "longStar"
    ? "star"
    : name.includes("point") || sample.texture === "circleIcon"
      ? "point"
      : "other";
}

interface SourceSlot {
  system: number;
  birth: number;
  seeds: ReadonlyMap<number, readonly ParticleSample[]>;
}

export interface SourceParticleBudgetReport {
  family: Family;
  sourceBirths: number;
  retainedBirths: number;
  meanLifetime: number;
  sourceBirthsPerSecond: number;
  retainedBirthsPerSecond: number;
}

/** Sonolus CPU/overdraw policy; the authored emitter and clocks stay unchanged. */
export function sampleSourceParticleSlots<T extends SourceSlot>(
  source: readonly T[],
  duration: number,
  loop: boolean,
  light: boolean,
  scale = 1,
  preserveSourceCount = false,
): { slots: T[]; report: SourceParticleBudgetReport[] } {
  const caps: Record<Family, number> = loop
    ? light
      ? { point: 32, star: 16, other: 16 }
      : { point: 48, star: 24, other: 24 }
    : light
      ? { point: 4, star: 3, other: 3 }
      : { point: 6, star: 4, other: 4 };
  const concurrent: Record<Family, number> = light
    ? { point: loop ? 2.5 : 3, star: 2, other: 2 }
    : { point: 4, star: 3, other: 3 };
  const families = new Map<Family, T[]>();
  for (const slot of source) {
    const sample = slot.seeds.values().next().value?.[0];
    if (!sample) continue;
    const family = sourceParticleFamily(sample);
    const slots = families.get(family) ?? [];
    slots.push(slot);
    families.set(family, slots);
  }
  const selected: T[] = [];
  const report: SourceParticleBudgetReport[] = [];
  const span = Math.max(1e-6, duration);
  for (const [family, slots] of families) {
    const lifetimes = slots.flatMap((slot) => [...slot.seeds.values()].map((samples) => samples[0]!.lifetime));
    const meanLifetime = lifetimes.reduce((sum, value) => sum + value, 0) / lifetimes.length;
    const target = preserveSourceCount ? slots.length : Math.min(
      slots.length,
      Math.ceil(caps[family] * scale),
      Math.max(1, Math.ceil((concurrent[family] * span * scale) / Math.max(1e-6, meanLifetime))),
    );
    const emitters = new Map<number, T[]>();
    for (const slot of slots) {
      const list = emitters.get(slot.system) ?? [];
      list.push(slot);
      emitters.set(slot.system, list);
    }
    const shares = [...emitters.values()].map((list) => {
      list.sort((a, b) => a.birth - b.birth);
      const ideal = (target * list.length) / slots.length;
      return { list, count: Math.floor(ideal), remainder: ideal % 1 };
    });
    shares.sort((a, b) => b.remainder - a.remainder);
    let remaining = target - shares.reduce((sum, share) => sum + share.count, 0);
    for (const share of shares)
      if (remaining > 0 && share.count < share.list.length) {
        share.count++;
        remaining--;
      }
    for (const { list, count } of shares)
      for (let index = 0; index < count; index++)
        selected.push(list[Math.floor(((index + 0.5) * list.length) / count)]!);
    report.push({
      family,
      sourceBirths: slots.length,
      retainedBirths: target,
      meanLifetime,
      sourceBirthsPerSecond: slots.length / span,
      retainedBirthsPerSecond: target / span,
    });
  }
  return { slots: selected, report };
}
