import { packAtlas, type Tile } from "./bake.ts";
import { decodePng } from "./textureBake.ts";
import { mergeNativeParticleDelta, type ParticleData, type ParticleDelta } from "./merge.ts";
import type { TrajectoryParticle } from "./trajectory.ts";

type ParticleGroup = { count: number; particles: TrajectoryParticle[] };

/** Replace qualified groups through the same pixel-preserving atlas merge. */
export function mergeParticleGroupDelta(
  data: ParticleData,
  png: Buffer,
  delta: ParticleDelta,
  indices: ReadonlySet<number>,
  decode = decodePng,
  append = false,
) {
  const effect = delta.effects[0]!;
  const previous = data.effects.find((e) => e.name === effect.name)!;
  const original = decode(png, "particle group baseline");
  const update = decode(delta.atlas.png, "particle group delta");
  const tiles: Tile[] = [];
  const oldIndices = new Map<number, number>(),
    newIndices = new Map<number, number>();
  const copy = (
    image: typeof original,
    sprites: ParticleData["sprites"],
    id: number,
    map: Map<number, number>,
    key: string,
  ) => {
    if (map.has(id)) return map.get(id)!;
    const s = sprites[id]!;
    const pixels = new Uint8Array(s.w * s.h * 4);
    for (let y = 0; y < s.h; y++)
      pixels.set(
        image.pixels.subarray(((s.y + y) * image.width + s.x) * 4, ((s.y + y) * image.width + s.x + s.w) * 4),
        y * s.w * 4,
      );
    const index = tiles.length;
    tiles.push({
      key: `${key}|${id}`,
      image: { width: s.w, height: s.h, pixels },
      expand: [1, 1],
      offset: [0, 0],
      response: new Float32Array(9).fill(1),
    });
    map.set(id, index);
    return index;
  };
  const replacements = (effect.groups as ParticleGroup[]).map((g) => ({
    ...g,
    particles: g.particles.map((p) => ({
      ...p,
      sprite: copy(update, delta.atlas.sprites, p.sprite, newIndices, "new"),
    })),
  }));
  const groups: ParticleGroup[] = [];
  let inserted = false;
  for (const [i, g] of (previous.groups as ParticleGroup[]).entries()) {
    if (indices.has(i)) {
      if (!inserted) groups.push(...replacements);
      inserted = true;
    } else
      groups.push({
        ...g,
        particles: g.particles.map((p) => ({
          ...p,
          sprite: copy(original, data.sprites, p.sprite, oldIndices, "old"),
        })),
      });
  }
  if (!inserted && append && !indices.size) groups.push(...replacements);
  else if (!inserted) throw new Error("No qualified particle groups selected");
  return mergeNativeParticleDelta(data, png, { ...delta, effects: [{ ...previous, groups }], atlas: packAtlas(tiles) });
}
