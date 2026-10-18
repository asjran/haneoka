import type { CompileResult } from "./compile.ts";
import { packAtlas } from "./bake.ts";
import { compileSourceLaneWarp, SOURCE_LANE_EFFECTS, type LaneWarpBudget } from "./laneWarp.ts";
import { mergeNativeParticleDelta, type ParticleData } from "./merge.ts";
import { EffectTracer } from "./trace.ts";

export type LaneParticleData = ParticleData;

/** Replace only the six lane programs and their private pixels. */
export async function compileLaneStripDelta(baseline: LaneParticleData, png: Buffer, releaseRoot: string,
  budget: LaneWarpBudget = {}) {
  if (SOURCE_LANE_EFFECTS.some(({ label }) =>
    !baseline.effects.some((effect) => effect.name === `Our Notes Lane ${label}`)))
    throw new Error("Lane delta needs all six existing Source lane effects");
  const tracer = new EffectTracer({ releaseRoot, currentQuality: 2 });
  try {
    await tracer.load();
    const warps = SOURCE_LANE_EFFECTS.map(({ label, kind }) => compileSourceLaneWarp(tracer, kind, `Our Notes Lane ${label}`, budget));
    const atlas = packAtlas(warps.flatMap((warp) => warp.tiles));
    const identity = Object.fromEntries(
      ["x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"].map((key) => [key, { [key]: 1 }]),
    );
    const effects = warps.map((warp, index) => ({
      name: `Our Notes Lane ${SOURCE_LANE_EFFECTS[index]!.label}`, transform: identity,
      groups: warp.groups.map((group) => ({
        count: 1, particles: group.particles.map((particle) => ({ ...particle, sprite: atlas.index.get(group.tile)! })),
      })),
    }));
    const delta: CompileResult = { effects, atlas, report: [], sourceBudgets: [] };
    const merged = mergeNativeParticleDelta(baseline, png, delta);
    return { data: merged.data, png: merged.png, report: {
      policy: "Source UV hybrid: disjoint lower envelopes and two moving upper UV bands",
      changedEffects: merged.affected.length, unchangedEffects: baseline.effects.length - merged.affected.length,
      appendedSprites: merged.appendedSprites, reusedSprites: merged.reusedSprites,
      protectedSprites: merged.protectedSprites, effects: warps.map((warp) => warp.report),
      maximumActiveQuadsPerLane: warps[0]!.groups.length, textureByteIdentical: false,
      retainedProgramsAndSpritePixels: "Protected by mergeNativeParticleDelta; only six named lane effects replaced",
    } };
  } finally {
    tracer.dispose();
  }
}
