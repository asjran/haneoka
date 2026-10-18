import { NATIVE_PARTICLE_PACKS } from "./particlePacks.ts";

export const NATIVE_PARTICLE_OPTIONAL_DRAW_CAPABILITIES: readonly string[] = NATIVE_PARTICLE_PACKS.flatMap(
  ({ key }) => [`Our Notes Source Connect Draw ${key}`, `Our Notes Source Connect Frame Draw ${key}`],
);
