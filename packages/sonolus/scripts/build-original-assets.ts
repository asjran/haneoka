import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { buildNativeNoteSkinPacks, decodeRgba8Png, encodeRgba8Png } from "./pack-original-note-skins.ts";
import { NATIVE_EFFECT_WIDTHS, compileNativeParticles } from "./native-particles/compile.ts";
import { resolveSonolusReleaseWorkspace } from "../src/server/releaseWorkspace.ts";
import { validateSonolusInputProvenance } from "../src/server/sonolusProvenance.ts";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type NormalizedRgba = readonly [red: number, green: number, blue: number, alpha: number];
type ByteRgba = readonly [red: number, green: number, blue: number, alpha: number];

const CHANNELS = [0, 1, 2, 3] as const;

function parseJson(text: string, sourceName: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${sourceName} is not valid JSON: ${detail}`, { cause: error });
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireJsonObject(value: JsonValue | undefined, path: string): JsonObject {
  if (!value || !isJsonObject(value)) throw new Error(`${path} must be an object`);
  return value;
}

function requireFiniteNumber(value: JsonValue | undefined, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  return value;
}

function byteAt(buffer: Uint8Array, index: number, context: string): number {
  const value = buffer[index];
  if (value === undefined) throw new Error(`${context}: byte ${index} is out of bounds for ${buffer.length} bytes`);
  return value;
}

const root = resolve(process.env.OUR_NOTES_ROOT || process.cwd());
const releaseServer = process.env.RELEASE_SERVER || "intl";
const workspace = resolveSonolusReleaseWorkspace(releaseServer, root);
const inputProvenance = validateSonolusInputProvenance(workspace, root);
const source = resolve(process.env.SONOLUS_ORIGINAL_ASSETS_DIR || resolve(root, "packages/sonolus/assets/original"));
const out = resolve(root, "packages/sonolus/dist/our-notes");

mkdirSync(out, { recursive: true });

function bakeSlideLineColors(input: Buffer): Buffer {
  const decoded = decodeRgba8Png(input, "skin.texture.png");
  const { width, height, pixels } = decoded;
  if (width < 862 || height < 3717) {
    throw new Error(`skin.texture.png is too small for compatibility sprites: ${width}x${height}`);
  }
  const stride = width * 4;

  const sourceSlideRow = Buffer.from(pixels.subarray(3716 * stride, 3716 * stride + 100 * 4));
  const writePaddedSlideStrip = (spriteX: number, rgba: NormalizedRgba): void => {
    // The declared sprite occupies y=3693..3700. Duplicate it once above and
    // below so bilinear filtering at either UV boundary never samples alpha 0.
    for (let y = 3692; y <= 3701; y++) {
      for (let x = -1; x <= 100; x++) {
        const sourceX = Math.max(0, Math.min(99, x));
        const sourceOffset = sourceX * 4;
        const targetOffset = y * stride + (spriteX + x) * 4;
        pixels[targetOffset] = Math.round(byteAt(sourceSlideRow, sourceOffset, "slide source") * rgba[0]);
        pixels[targetOffset + 1] = Math.round(byteAt(sourceSlideRow, sourceOffset + 1, "slide source") * rgba[1]);
        pixels[targetOffset + 2] = Math.round(byteAt(sourceSlideRow, sourceOffset + 2, "slide source") * rgba[2]);
        pixels[targetOffset + 3] = Math.round(byteAt(sourceSlideRow, sourceOffset + 3, "slide source") * rgba[3]);
      }
    }
  };

  // SlideLine judgement-end color keys from the slide line material. The
  // uncoloured strip is retained for Sonolus fallback sprite names; custom
  // connector archetypes use the three coloured strips.
  writePaddedSlideStrip(401, [1, 1, 1, 1]);
  writePaddedSlideStrip(505, [0.4796607196, 0.2862745523, 1, 0.8627451062]);
  writePaddedSlideStrip(609, [0.6041513681, 0.334905684, 1, 0.8627451062]);
  writePaddedSlideStrip(713, [0.470588237, 0.384313732, 1, 0.509803951]);

  const writePaddedSolid = (spriteX: number, rgba: ByteRgba): void => {
    for (let y = 3692; y <= 3701; y++) {
      for (let x = -1; x <= 8; x++) {
        const targetOffset = y * stride + (spriteX + x) * 4;
        for (const channel of CHANNELS) {
          pixels[targetOffset + channel] = rgba[channel];
        }
      }
    }
  };
  // lane_base's opaque centre is exactly sRGBA(9,19,46,1). The orthographic
  // preview uses that flat colour; borders follow the judgement white and
  // dividers use the serialized lane-line grey at restrained alpha.
  writePaddedSolid(817, [9, 19, 46, 255]);
  writePaddedSolid(829, [250, 246, 255, 255]);
  writePaddedSolid(841, [156, 156, 156, 72]);
  // The pair-note prefab uses Sprite-Unlit-Default with an untinted white
  // SpriteRenderer. Keep this independent from the purple SlideLine strips.
  writePaddedSolid(853, [255, 255, 255, 255]);

  // LiveLaneLine styles 0/2. Main lines interpolate alpha 1 -> 0 from
  // judgment to horizon; Space ticks use the serialized uniform gray.
  const lanePixels: ReadonlyArray<readonly [x: number, y: number, rgba: NormalizedRgba]> = [
    [326, 3692, [0.6156863, 0.6156863, 0.6156863, 0]],
    [326, 3693, [0.6132076, 0.6132076, 0.6132076, 1]],
    [328, 3692, [0.6117647, 0.6117647, 0.6117647, 1]],
    [330, 3692, [250 / 255, 246 / 255, 1, 1]],
  ];
  for (const [x, y, rgba] of lanePixels) {
    const targetOffset = y * stride + x * 4;
    for (const channel of CHANNELS) {
      pixels[targetOffset + channel] = Math.round(rgba[channel] * 255);
    }
  }

  return encodeRgba8Png(decoded);
}

const commonTexture = decodeRgba8Png(
  bakeSlideLineColors(readFileSync(resolve(source, "skin.texture.png"))),
  "baked common Sonolus texture",
);
const nativeSkinPacks = buildNativeNoteSkinPacks(resolve(out, "skins"), commonTexture);
for (const retired of ["skin.data", "skin.texture.png"]) rmSync(resolve(out, retired), { force: true });

// Engine-facing sprite coverage: every "Our Notes ..." sprite the vendored
// engine references must exist in the default skin pack, or Sonolus would
// silently fall back to stock sprites (the classic "wrong notes" symptom).
{
  const engineRoot = dirname(fileURLToPath(import.meta.resolve("@haneoka/cassiopeia-sonolus-engine/package.json")));
  const referencedNames = new Set<string>();
  for (const [facet, dataDir] of [
    ["play", "playData"],
    ["watch", "watchData"],
    ["preview", "previewData"],
    ["tutorial", "tutorialData"],
  ] as const) {
    const skinFile = resolve(engineRoot, facet, "src", "engine", dataDir, "skin.ts");
    if (!existsSync(skinFile)) continue;
    const source = readFileSync(skinFile, "utf8");
    for (const match of source.matchAll(/'([^']*)'/g)) {
      if (match[1]!.startsWith("Our Notes ")) referencedNames.add(match[1]!);
    }
  }
  const defaultSkin = JSON.parse(gunzipSync(readFileSync(resolve(out, "skins", "skin001", "skin.data"))).toString("utf8")) as {
    sprites: Array<{ name?: unknown }>;
  };
  const available = new Set(defaultSkin.sprites.map((sprite) => String(sprite.name)));
  // Slot sprites belong to the retired PJS slot archetypes (no-ops here), and
  // getArrowSpriteIndex only reaches the first four Up tiers, so packs whose
  // authored atlas ships four Up arrows are complete for every reachable draw.
  const optional = (name: string): boolean =>
    name.startsWith("Our Notes Slot ") || /Our Notes Flick Arrow (Red|Yellow) Up [5-8]$/.test(name);
  const missing = [...referencedNames].filter((name) => !available.has(name) && !optional(name));
  if (missing.length) {
    throw new Error(`Skin pack skin001 is missing engine-referenced sprites: ${missing.join(", ")}`);
  }
  console.log(`skin001 covers all ${referencedNames.size} engine-referenced sprite names`);
}

// Native effect001 particles: the web renderer's own evaluator is traced
// headlessly and compiled into native Sonolus particle effects (per-instance
// randomness, baked HDR colour and bloom). See native-particles/compile.ts.
const compiled = await compileNativeParticles({ releaseRoot: workspace.releaseRoot });
const particleData = {
  width: compiled.atlas.width,
  height: compiled.atlas.height,
  interpolation: true,
  sprites: compiled.atlas.sprites,
  effects: compiled.effects,
};
writeFileSync(resolve(out, "particle.data"), gzipSync(JSON.stringify(particleData), { level: 9 }));
writeFileSync(resolve(out, "particle.texture.png"), compiled.atlas.png);
writeFileSync(
  resolve(out, "native-particle-report.json"),
  JSON.stringify(
    {
      schema: "our-notes-native-particles-v2",
      source: "effect001",
      widths: NATIVE_EFFECT_WIDTHS,
      releaseInputsValidated: inputProvenance.sourceProvenanceValidated,
      atlas: { width: compiled.atlas.width, height: compiled.atlas.height, bytes: compiled.atlas.png.length },
      effects: compiled.report,
    },
    null,
    2,
  ),
);
console.log(
  `compiled native Sonolus particles: ${compiled.effects.length} effects, ` +
    `${compiled.atlas.sprites.length} sprites (${compiled.atlas.width}x${compiled.atlas.height})`,
);

const effectSourceFile = resolve(source, "effect.data");
const effectData = requireJsonObject(
  parseJson(gunzipSync(readFileSync(effectSourceFile)).toString("utf8"), effectSourceFile),
  "effect.data",
);
const effectClips = effectData.clips;
if (!Array.isArray(effectClips)) throw new Error("effect.data.clips must be an array");
for (const [index, value] of effectClips.entries()) {
  const entry = requireJsonObject(value, `effect.data.clips[${index}]`);
  if (typeof entry.name !== "string") throw new Error(`effect.data.clips[${index}].name must be a string`);
  entry.name = entry.name.replace(/^Sekai /, "Our Notes ");
}
writeFileSync(resolve(out, "effect.data"), gzipSync(JSON.stringify(effectData), { level: 9 }));
copyFileSync(resolve(source, "effect.audio"), resolve(out, "effect.audio"));

console.log(
  `built Our Notes Sonolus resources: ${nativeSkinPacks.map((pack) => `${pack.skinName}=${pack.sprites} sprites/${pack.nativeArea} native px`).join(", ")}, ` +
    `${compiled.effects.length} native particle effects ` +
    `-> ${out} (validated release inputs: ${inputProvenance.sourceId}/${inputProvenance.releaseId})`,
);
