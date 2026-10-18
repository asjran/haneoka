import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { decodeRgba8Png, encodeRgba8Png } from "./pack-original-note-skins.ts";

interface Recipe {
  schema: string;
  curves: Array<{ path: string; sha256: string }>;
  sprites: Array<{ name: string; correction: [number, number, number] }>;
  inputs: Array<{ skin: string; rgbaSha256: string; metadataSha256: string }>;
}
type Sprite = { name: string; x: number; y: number; w: number; h: number };
// Runtime skips the body of range zero; producers use either empty or core aliases.
const unusedBody = (name: string) => /^Our Notes Source Connect Draw (standard|light|simple) 00$/u.test(name);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => [key, canonical(child)]),
        )
      : value;
const mix = (value: number, correction: number) =>
  correction < 0 ? value * (1 + correction) : value + (1 - value) * correction;

/** Apply the admitted material fit after geometry/UV packing, leaving every alpha and other sprite exact. */
export function buildConnectWallMaterialAssets(directory: string, recipeFile: string, engineRoot: string) {
  const recipe = JSON.parse(readFileSync(recipeFile, "utf8")) as Recipe;
  if (recipe.schema !== "our-notes-connect-wall-material-v1") throw new Error("Unknown wall material recipe");
  for (const file of recipe.curves)
    if (hash(readFileSync(resolve(engineRoot, file.path))) !== file.sha256)
      throw new Error(`Wall material engine contract changed: ${file.path}`);
  const corrections = new Map(recipe.sprites.map((sprite) => [sprite.name, sprite.correction]));
  if (
    corrections.size !== recipe.sprites.length ||
    recipe.sprites.some(
      (sprite) =>
        !/^Our Notes Source Connect Draw simple \d{2}$/u.test(sprite.name) ||
        sprite.correction.some((value) => !Number.isFinite(value) || value < -0.3 || value > 1),
    )
  )
    throw new Error("Invalid wall material correction");
  const skins = recipe.inputs.map((input) => {
    const root = resolve(directory, "skins", input.skin);
    const metadata = gunzipSync(readFileSync(resolve(root, "skin.data")));
    const texture = decodeRgba8Png(readFileSync(resolve(root, "skin.texture.png")), input.skin);
    const definition = JSON.parse(metadata.toString("utf8")) as { sprites: Sprite[] };
    const named = {
      ...definition,
      sprites: [...definition.sprites]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((sprite) => (unusedBody(sprite.name) ? { name: sprite.name } : sprite)),
    };
    if (
      hash(Buffer.from(JSON.stringify(canonical(named)))) !== input.metadataSha256 ||
      hash(texture.pixels) !== input.rgbaSha256
    )
      throw new Error(`Wall material qualified atlas changed: ${input.skin}`);
    const found = new Set(
      definition.sprites.filter((sprite) => corrections.has(sprite.name)).map((sprite) => sprite.name),
    );
    if (found.size !== corrections.size) throw new Error(`Wall material sprite missing: ${input.skin}`);
    const original = Buffer.from(texture.pixels);
    const protectedPixels = new Uint8Array(texture.width * texture.height);
    for (const sprite of definition.sprites)
      if (!corrections.has(sprite.name) && !unusedBody(sprite.name))
        for (let y = Math.max(0, sprite.y - 2); y < Math.min(texture.height, sprite.y + sprite.h + 2); y++)
          for (let x = Math.max(0, sprite.x - 2); x < Math.min(texture.width, sprite.x + sprite.w + 2); x++)
            protectedPixels[y * texture.width + x] = 1;
    const modified = new Set<number>();
    for (const sprite of definition.sprites) {
      const correction = corrections.get(sprite.name);
      if (!correction) continue;
      for (let y = Math.max(0, sprite.y - 2); y < Math.min(texture.height, sprite.y + sprite.h + 2); y++)
        for (let x = Math.max(0, sprite.x - 2); x < Math.min(texture.width, sprite.x + sprite.w + 2); x++) {
          const pixel = y * texture.width + x;
          if (protectedPixels[pixel] || modified.has(pixel)) continue;
          modified.add(pixel);
          for (let channel = 0; channel < 3; channel++)
            texture.pixels[pixel * 4 + channel] = Math.round(
              mix(original[pixel * 4 + channel]! / 255, correction[channel]!) * 255,
            );
        }
    }
    for (let pixel = 0; pixel < protectedPixels.length; pixel++) {
      if (texture.pixels[pixel * 4 + 3] !== original[pixel * 4 + 3]) throw new Error("Wall material changed alpha");
      if (
        protectedPixels[pixel] &&
        [0, 1, 2, 3].some((channel) => texture.pixels[pixel * 4 + channel] !== original[pixel * 4 + channel])
      )
        throw new Error("Wall material changed a protected sprite");
    }
    writeFileSync(resolve(root, "skin.texture.png"), encodeRgba8Png(texture));
    return {
      skin: input.skin,
      width: texture.width,
      height: texture.height,
      metadataExact: true,
      alphaExact: true,
      nonWallSpritesAndGuttersExact: true,
      rgbaSha256: hash(texture.pixels),
    };
  });
  const receipt = {
    schema: recipe.schema,
    recipeSha256: hash(readFileSync(recipeFile)),
    skins,
    unchangedRanges: 9,
    unchangedWallSlotsPerProfile: 18,
    addedDraws: 0,
    engineChanges: false,
  };
  writeFileSync(resolve(directory, "connect-wall-material-proof.json"), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}
