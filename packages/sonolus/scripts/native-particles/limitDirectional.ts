// Metadata-only reduction of Light side-flick scatter. Keep deterministic
// layers and every retained particle's animation together with its group.
interface Expression { [key: string]: number }
interface Channel { from: Expression; to: Expression; ease?: string }
interface Particle {
  sprite: number;
  color: string;
  start: number;
  duration: number;
  x: Channel;
  y: Channel;
  w: Channel;
  h: Channel;
  r: Channel;
  a: Channel;
}
interface Group { count: number; particles: Particle[] }
interface Effect { name: string; groups: Group[] }
export interface DirectionalParticleData { effects: Effect[] }

const channels = ["x", "y", "w", "h", "r", "a"] as const;
export const isDirectionalScatter = (group: Group): boolean =>
  group.particles.some((particle) => channels.some((key) =>
    [particle[key].from, particle[key].to].some((expression) =>
      Object.entries(expression).some(([term, value]) => term !== "c" && value !== 0),
    ),
  ));

const stats = (groups: Group[]) => ({
  groups: groups.length,
  instances: groups.reduce((sum, group) => sum + group.count, 0),
  weightedDefinitions: groups.reduce((sum, group) => sum + group.count * group.particles.length, 0),
});

export function limitDirectionalParticles<T extends DirectionalParticleData>(baseline: T) {
  const changes: Array<{
    name: string;
    before: ReturnType<typeof stats>;
    after: ReturnType<typeof stats>;
    scatterBefore: ReturnType<typeof stats>;
    scatterAfter: ReturnType<typeof stats>;
    preservedDeterministicGroups: number;
  }> = [];
  const effects = baseline.effects.map((effect) => {
    if (!/^Our Notes Light Flick (Left|Right) (Great )?W(4|6|8|12|24) P0$/.test(effect.name)) return effect;
    // Stratify by sprite/color sequence so rare scatter shapes survive. Order
    // each family by emission time and sample centered, evenly spaced slots.
    const families = new Map<string, Array<{ index: number; group: Group }>>();
    effect.groups.forEach((group, index) => {
      if (!Number.isSafeInteger(group.count) || group.count < 1)
        throw new Error(`Invalid group count in ${effect.name}`);
      if (!isDirectionalScatter(group)) return;
      const key = JSON.stringify(group.particles.map(({ sprite, color }) => [sprite, color]));
      const family = families.get(key) ?? [];
      family.push({ index, group });
      families.set(key, family);
    });
    const counts = new Map<number, number>();
    for (const family of families.values()) {
      family.sort((a, b) => Math.min(...a.group.particles.map((p) => p.start)) -
        Math.min(...b.group.particles.map((p) => p.start)) || a.index - b.index);
      const total = family.reduce((sum, { group }) => sum + group.count, 0);
      const target = Math.ceil(total / 2);
      let selected = 0, offset = 0;
      for (const { index, group } of family) {
        let count = 0;
        const end = offset + group.count;
        while (selected < target && Math.floor((selected + 0.5) * total / target) < end) {
          count++;
          selected++;
        }
        counts.set(index, count);
        offset = end;
      }
      if (selected !== target) throw new Error(`Incomplete sampling in ${effect.name}`);
    }
    const groups = effect.groups.flatMap((group, index) => {
      const count = counts.get(index);
      if (count === undefined || count === group.count) return [group];
      return count === 0 ? [] : [{ ...group, count }];
    });
    if (groups.length === effect.groups.length && groups.every((group, i) => group === effect.groups[i])) return effect;
    changes.push({
      name: effect.name,
      before: stats(effect.groups), after: stats(groups),
      scatterBefore: stats(effect.groups.filter(isDirectionalScatter)),
      scatterAfter: stats(groups.filter(isDirectionalScatter)),
      preservedDeterministicGroups: effect.groups.filter((group) => !isDirectionalScatter(group)).length,
    });
    return { ...effect, groups };
  });
  return { data: { ...baseline, effects }, changes };
}
