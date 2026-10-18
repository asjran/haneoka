import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { decodePng, encodeRgbaPng, type RgbaImage } from "./textureBake.ts";
import { repackParticleAtlas } from "./repack.ts";
import type { ParticleData } from "./merge.ts";

interface MaterialParticle extends Record<string, unknown> {
  sprite: number;
  color: string;
  a: unknown;
}
interface MaterialGroup extends Record<string, unknown> {
  particles: MaterialParticle[];
}
interface ResponseGroup {
  effect: string;
  group: number;
  beforeSha256: string;
  phases: Array<{ index: number; sprite: string; color: string; a: unknown }>;
}
interface ResponseProfile {
  groups: ResponseGroup[];
  variants: Array<{ key: string; file: string; sha256: string }>;
}
interface ResponseRecipe {
  schema: string;
  profiles: Record<"standard" | "light", ResponseProfile>;
}

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, stable(value)])) : value;

/** RGBA content identity survives the point producer's atlas relocation. */
export function sceneSpriteKey(image: RgbaImage, sprite: { x: number; y: number; w: number; h: number }) {
  const bytes = new Uint8Array(sprite.w * sprite.h * 4);
  for (let y = 0; y < sprite.h; y++) bytes.set(image.pixels.subarray(
    ((sprite.y + y) * image.width + sprite.x) * 4,
    ((sprite.y + y) * image.width + sprite.x + sprite.w) * 4), y * sprite.w * 4);
  return `${sprite.w}x${sprite.h}:${hash(bytes)}`;
}

export function sceneGroupHash(group: MaterialGroup, spriteKeys: readonly string[]) {
  return hash(JSON.stringify(stable({ ...group, particles: group.particles.map((particle) => ({
    ...particle, sprite: spriteKeys[particle.sprite], color: particle.color.toLowerCase(),
  })) })));
}

/** Apply the qualified Source/OVER response after all geometry and point baking. */
export function applySourceStarSceneResponse(
  original: ParticleData, png: Buffer, profile: ResponseProfile, profileDirectory: string, maximumAtlasHeight = original.height,
) {
  const data = structuredClone(original), image = decodePng(png, "scene material baseline");
  const spriteKeys = data.sprites.map((sprite) => sceneSpriteKey(image, sprite));
  const indices = new Map<string, number>();
  for (const [index, key] of spriteKeys.entries()) if (!indices.has(key)) indices.set(key, index);
  const groups = profile.groups.map((patch) => {
    const effect = data.effects.find((effect) => effect.name === patch.effect);
    const group = (effect?.groups as MaterialGroup[] | undefined)?.[patch.group];
    if (!group || sceneGroupHash(group, spriteKeys) !== patch.beforeSha256)
      throw new Error(`Source scene material input changed: ${patch.effect} group ${patch.group}`);
    return { patch, group };
  });
  const variants = profile.variants.flatMap((variant) => {
    if (indices.has(variant.key)) return [];
    const bytes = readFileSync(resolve(profileDirectory, variant.file));
    if (hash(bytes) !== variant.sha256) throw new Error(`Source scene material variant changed: ${variant.file}`);
    const decoded = decodePng(bytes, variant.file);
    if (sceneSpriteKey(decoded, { x: 0, y: 0, w: decoded.width, h: decoded.height }) !== variant.key)
      throw new Error(`Source scene material RGBA changed: ${variant.file}`);
    return [{ ...variant, image: decoded }];
  });
  let texture = png;
  if (variants.length) {
    const width = image.width + variants.reduce((sum, variant) => sum + variant.image.width + 2, 0);
    const height = Math.max(image.height, ...variants.map((variant) => variant.image.height + 2));
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < image.height; y++) pixels.set(image.pixels.subarray(
      y * image.width * 4, (y + 1) * image.width * 4), y * width * 4);
    let x = image.width + 1;
    for (const variant of variants) {
      const source = variant.image, id = data.sprites.length;
      data.sprites.push({ x, y: 1, w: source.width, h: source.height });
      indices.set(variant.key, id);
      for (let y = -1; y <= source.height; y++) for (let px = -1; px <= source.width; px++) {
        const from = (Math.max(0, Math.min(source.height - 1, y)) * source.width
          + Math.max(0, Math.min(source.width - 1, px))) * 4;
        pixels.set(source.pixels.subarray(from, from + 4), ((y + 1) * width + x + px) * 4);
      }
      x += source.width + 2;
    }
    data.width = width; data.height = height;
    texture = encodeRgbaPng({ width, height, pixels });
  }
  let phases = 0;
  for (const { patch, group } of groups) for (const phase of patch.phases) {
    const particle = group.particles[phase.index], sprite = indices.get(phase.sprite);
    if (!particle || sprite === undefined) throw new Error(`Missing Source scene material phase: ${patch.effect}`);
    particle.sprite = sprite; particle.color = phase.color; particle.a = phase.a;
    phases++;
  }
  const result = variants.length ? repackParticleAtlas(data, texture, original.width, { denseSearch: true, maximumHeight: maximumAtlasHeight })
    : { data, png: texture };
  return { ...result, groups: groups.length, phases, variants: variants.length };
}

/** The response asset is keyed to the exact authored groups and source texels. */
export function buildSourceStarSceneMaterialAssets(directory: string, recipePath: string, maximumAtlasHeights: Partial<Record<"standard" | "light", number>> = {}) {
  const bytes = readFileSync(recipePath), recipe = JSON.parse(bytes.toString()) as ResponseRecipe;
  if (recipe.schema !== "our-notes-source-star-scene-response-v1") throw new Error("Unknown Source scene response recipe");
  const profiles = (["standard", "light"] as const).map((profile) => {
    const root = resolve(directory, "particles", profile);
    const data = JSON.parse(gunzipSync(readFileSync(resolve(root, "particle.data"))).toString()) as ParticleData;
    const result = applySourceStarSceneResponse(data, readFileSync(resolve(root, "particle.texture.png")),
      recipe.profiles[profile], dirname(recipePath), maximumAtlasHeights[profile] ?? data.height);
    const output = Buffer.from(JSON.stringify(result.data));
    writeFileSync(resolve(root, "particle.data"), gzipSync(output));
    writeFileSync(resolve(root, "particle.json"), output);
    writeFileSync(resolve(root, "particle.texture.png"), result.png);
    return { profile, groups: result.groups, phases: result.phases, variants: result.variants,
      dataSha256: hash(gzipSync(output)), textureSha256: hash(result.png) };
  });
  const report = { schema: recipe.schema, recipeSha256: hash(bytes), profiles };
  writeFileSync(resolve(directory, "source-star-scene-material-proof.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}
