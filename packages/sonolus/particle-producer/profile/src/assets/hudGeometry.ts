import type { HudSpriteGeometry } from "./manifest.js";

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid HUD sprite record");
  return value as Record<string, unknown>;
};
const number = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid HUD sprite geometry number");
  return value;
};

/** Native Simple Image rect and padding. The cropped Sprite PNG supplies only the texture rectangle. */
export function parseHudSpriteGeometry(record: unknown): HudSpriteGeometry {
  const data = object(object(record).data);
  const rect = object(data.m_Rect);
  const render = object(data.m_RD);
  return geometry(number(rect.width), number(rect.height), render);
}

function geometry(rectWidth: number, rectHeight: number, render: Record<string, unknown>): HudSpriteGeometry {
  const texture = object(render.textureRect);
  const offset = object(render.textureRectOffset);
  const result = {
    rectWidth,
    rectHeight,
    textureWidth: number(texture.width),
    textureHeight: number(texture.height),
    offsetX: number(offset.x),
    offsetY: number(offset.y),
  };
  if (rectWidth <= 0 || rectHeight <= 0 || result.textureWidth <= 0 || result.textureHeight <= 0) {
    throw new Error("Empty native HUD sprite geometry");
  }
  if (((number(render.settingsRaw) >>> 2) & 15) !== 0) throw new Error("Rotated native HUD sprite geometry");
  return result;
}

/**
 * LiveComboN/FC/AP atlases retain their ordered sprite names and render-data map.
 * Formal combo sprites all have a centre pivot; atlas uvTransform encodes the
 * authored pixel centre plus atlasRectOffset. Recover the full untrimmed rect,
 * using UGUI's integer sprite dimensions, without another request per digit.
 */
export function parseHudComboAtlasGeometry(record: unknown): Readonly<Record<string, HudSpriteGeometry>> {
  const data = object(object(record).data);
  const names = data.m_PackedSpriteNamesToIndex;
  const entries = data.m_RenderDataMap;
  if (!Array.isArray(names) || !Array.isArray(entries) || names.length !== entries.length) {
    throw new Error("Invalid native combo atlas geometry map");
  }
  const result: Record<string, HudSpriteGeometry> = {};
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const pair = entries[index];
    if (typeof name !== "string" || !name || !Array.isArray(pair) || pair.length !== 2 || result[name]) {
      throw new Error("Invalid native combo sprite identity");
    }
    const render = object(pair[1]);
    const uv = object(render.uvTransform);
    const atlasOffset = object(render.atlasRectOffset);
    // Every source sprite in these three native atlases has pivot (.5,.5).
    // Native m_Rect dimensions are integral; packed atlas offsets have float32 rounding.
    const width = Math.round(2 * (number(uv.y) - number(atlasOffset.x)));
    const height = Math.round(2 * (number(uv.w) - number(atlasOffset.y)));
    result[name] = geometry(width, height, render);
  }
  return result;
}
