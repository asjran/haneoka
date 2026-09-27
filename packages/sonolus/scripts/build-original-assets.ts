import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { buildNativeNoteSkinPacks, decodeRgba8Png, encodeRgba8Png } from "./pack-original-note-skins.ts";
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

// Composite the reconstructed 3D wall, billboards and HDR/Bloom offline.
// Never expand every Unity particle into thousands of runtime segments.
const bakedRoot = resolve(process.env.SONOLUS_BAKED_EFFECTS_DIR || resolve(root, "packages/sonolus/assets/baked"));
const capture = requireJsonObject(
  parseJson(readFileSync(resolve(bakedRoot, "capture.json"), "utf8"), "effect capture provenance"),
  "effect capture provenance",
);
// This unpublished resource is usable without claiming that a capture of our
// own renderer proves Unity parity. Preserve that distinction in build output.
if (capture.referenceValidated !== true) {
  const message = "Baked effects have partial original-video review; full visual parity is not established.";
  if (process.env.SONOLUS_REQUIRE_REFERENCE_PARITY === "1") throw new Error(message);
  console.warn(message);
}
const baked = requireJsonObject(
  parseJson(readFileSync(resolve(bakedRoot, "particle.json"), "utf8"), "baked particles"),
  "baked particles",
);
if (baked.width !== 8192 || baked.height !== 8192 || !Array.isArray(baked.sprites) || !Array.isArray(baked.effects)) {
  throw new Error("Invalid baked particle atlas; run Cassiopeia's effect capture first");
}
const bakedTexture = decodeRgba8Png(readFileSync(resolve(bakedRoot, "particle.texture.png")), "baked atlas");
if (bakedTexture.width !== 8192 || bakedTexture.height !== 8192) throw new Error("Baked texture dimensions disagree");
const baseNoteNames = [
  ...["Normal", "Slide", "Flick", "Flick Left", "Flick Right", "Connect"].flatMap((name) =>
    ["", " Great", " Good", " Bad"].map((judgement) => `Our Notes Native ${name}${judgement}`),
  ),
  "Our Notes Native Slide Loop",
];
const expectedNames = [
  ...baseNoteNames.flatMap((name) => [name, `${name} Width 4`, `${name} Width 10`]),
  ...["In Vain", "Normal", "Slide", "Flick", "Flick Left", "Flick Right"].map((name) => `Our Notes Lane ${name}`),
];
const actualNames = baked.effects.map((e) => requireJsonObject(e, "baked effect").name);
if (
  new Set(actualNames).size !== actualNames.length ||
  expectedNames.length !== actualNames.length ||
  expectedNames.some((n) => !actualNames.includes(n))
) {
  throw new Error("Baked effect names do not cover every native judgement state");
}
const bakedSpriteCount = baked.sprites.length;
for (const value of baked.sprites) {
  const sprite = requireJsonObject(value, "baked sprite");
  const x = requireFiniteNumber(sprite.x, "sprite.x"),
    y = requireFiniteNumber(sprite.y, "sprite.y");
  const w = requireFiniteNumber(sprite.w, "sprite.w"),
    h = requireFiniteNumber(sprite.h, "sprite.h");
  if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 8192 || y + h > 8192)
    throw new Error("Baked sprite is outside the atlas");
}
const budget = baked.effects.map((value) => {
  const effect = requireJsonObject(value, "baked effect");
  if (!Array.isArray(effect.groups) || effect.groups.length > 32 || !effect.groups.length)
    throw new Error("Effect exceeds the 32-frame budget");
  let end = 0;
  for (const value of effect.groups) {
    const group = requireJsonObject(value, "baked group");
    if (group.count !== 1 || !Array.isArray(group.particles) || group.particles.length !== 1)
      throw new Error("Only one quad per animation frame is permitted");
    const p = requireJsonObject(group.particles[0], "baked frame");
    const alpha = requireJsonObject(p.a, "frame.a");
    if (
      alpha.ease !== "none" ||
      requireJsonObject(alpha.from, "alpha.from").c !== 1 ||
      requireJsonObject(alpha.to, "alpha.to").c !== 0
    )
      throw new Error("Frames must step alpha to zero at their inclusive end boundary");
    const start = requireFiniteNumber(p.start, "frame.start"),
      duration = requireFiniteNumber(p.duration, "frame.duration");
    if (duration <= 0 || Math.abs(start - end) > 1e-9)
      throw new Error("Baked frames must be contiguous and non-overlapping");
    if (!Number.isInteger(p.sprite) || typeof p.sprite !== "number" || p.sprite < 0 || p.sprite >= bakedSpriteCount)
      throw new Error("Invalid frame sprite");
    end = start + duration;
  }
  if (Math.abs(end - 1) > 1e-9) throw new Error("Baked animation must cover the complete native duration");
  return { name: effect.name, allocatedQuads: effect.groups.length, peakVisibleQuads: 1 };
});
const particleData = baked;
writeFileSync(resolve(out, "particle.data"), gzipSync(JSON.stringify(particleData), { level: 9 }));
writeFileSync(resolve(out, "particle.texture.png"), encodeRgba8Png(bakedTexture));
writeFileSync(
  resolve(out, "particle-budget.json"),
  JSON.stringify(
    {
      profile: "baked-3d-30fps",
      releaseInputsValidated: inputProvenance.sourceProvenanceValidated,
      sourceProvenanceValidated: false,
      visualReferenceValidated: capture.referenceValidated === true,
      referenceValidated: capture.referenceValidated === true,
      maxFrames: 32,
      textureBytes: 8192 * 8192 * 4,
      effects: budget,
    },
    null,
    2,
  ),
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
    `${baked.effects.length} native particle effects ` +
    `-> ${out} (validated release inputs: ${inputProvenance.sourceId}/${inputProvenance.releaseId})`,
);
