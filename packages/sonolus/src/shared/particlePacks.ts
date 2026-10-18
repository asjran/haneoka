export const NATIVE_PARTICLE_PACKS = [
  { key: "standard", name: "ourNotesParticle", prefix: "Our Notes Native" },
  { key: "light", name: "ourNotesParticleLight", prefix: "Our Notes Light" },
  { key: "simple", name: "ourNotesParticleSimple", prefix: "Our Notes Simple" },
] as const;

export type NativeParticlePackKey = (typeof NATIVE_PARTICLE_PACKS)[number]["key"];
export const DEFAULT_NATIVE_PARTICLE_PACK = NATIVE_PARTICLE_PACKS[2];
export const NATIVE_PARTICLE_SEMANTIC_PREFIX = "Our Notes Native";
export const NATIVE_PARTICLE_SIMPLE_CAPABILITY = "Our Notes Profile Simple";
export const NATIVE_PARTICLE_SOURCE_LOOP_CAPABILITY = "Our Notes Source SimpleLoop Point";
export const NATIVE_PARTICLE_SOURCE_LOOP_CAPABILITIES: readonly string[] = [
  NATIVE_PARTICLE_SOURCE_LOOP_CAPABILITY,
  ...Array.from(
    { length: 15 },
    (_, i) => `${NATIVE_PARTICLE_SOURCE_LOOP_CAPABILITY} Phase ${String(i + 1).padStart(2, "0")}`,
  ),
];

const widths = [4, 6, 8, 12, 24] as const;
const names = (bases: readonly string[], suffixes: readonly string[]) =>
  bases.flatMap((base) =>
    widths.flatMap((width) =>
      suffixes.map((suffix) => `${NATIVE_PARTICLE_SEMANTIC_PREFIX} ${base} W${width} ${suffix}`),
    ),
  );
const flickShort = ["Flick Short", "Flick Left Short", "Flick Right Short"];
const background = names(["Normal", "Flick"], ["B0"]);
const early = names(["Normal", "Flick"], ["P0 Early"]);
const slideShort = names(["Slide Short"], ["P0", "P1", "P2", "P3"]);

/** Exact authored omissions; B0/Early/SlideShort stay required in Standard/Light. */
export function nativeParticlePresencePolicy(key: NativeParticlePackKey) {
  if (key === "simple") {
    return {
      required: [
        NATIVE_PARTICLE_SIMPLE_CAPABILITY,
        ...NATIVE_PARTICLE_SOURCE_LOOP_CAPABILITIES,
        ...names(flickShort, ["P0", "P1", "P3"]),
      ],
      absent: [...names(flickShort, ["P2"]), ...slideShort, ...background, ...early],
    };
  }
  return {
    required: [...slideShort, ...background, ...early],
    absent: [
      NATIVE_PARTICLE_SIMPLE_CAPABILITY,
      ...NATIVE_PARTICLE_SOURCE_LOOP_CAPABILITIES,
      ...names(flickShort, ["P0", "P1", "P2", "P3"]),
    ],
  };
}
