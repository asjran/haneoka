export interface NativeIntroSpriteData {
  positions: Float32Array;
  uv: Float32Array;
  indices: Uint16Array;
  rect: readonly [number, number, number, number];
  textureRect: readonly [number, number, number, number];
  textureRectOffset: readonly [number, number];
  pivot: readonly [number, number];
  border: readonly [number, number, number, number];
  pixelsToUnits: number;
  texture: unknown;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native intro Sprite data");
  return value as Record<string, unknown>;
};
const finite = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid native intro Sprite number");
  return value;
};
const bytes = (value: unknown): Uint8Array => {
  if (!Array.isArray(value) || value.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    throw new Error("Native intro Sprite requires projected bytes");
  return Uint8Array.from(value);
};
const rectangle = (value: unknown): readonly [number, number, number, number] => {
  const r = object(value);
  return [finite(r.x), finite(r.y), finite(r.width), finite(r.height)];
};

/** Decode the 24 actual unpacked intro sprites; retain original Unity geometry and texture identity. */
export function parseNativeIntroSprite(value: unknown, textureWidth: number, textureHeight: number): NativeIntroSpriteData {
  const root = object(value);
  if (root.type !== "Sprite") throw new Error("Native intro sprite requires its original Sprite record");
  const data = object(root.data), rd = object(data.m_RD), vd = object(rd.m_VertexData);
  const atlas = object(data.m_SpriteAtlas);
  if (rd.settingsRaw !== 64 || atlas.m_FileID !== 0 || atlas.m_PathID !== "0")
    throw new Error("Unsupported packed native intro Sprite");
  if (!Number.isInteger(textureWidth) || !Number.isInteger(textureHeight) || textureWidth <= 0 || textureHeight <= 0)
    throw new Error("Native intro Sprite requires actual decoded texture dimensions");
  const count = finite(vd.m_VertexCount), channels = vd.m_Channels;
  if (!Number.isSafeInteger(count) || count < 1 || count > 65535 || !Array.isArray(channels))
    throw new Error("Invalid native intro Sprite vertex layout");
  const position = object(channels[0]);
  if (position.stream !== 0 || position.format !== 0 || position.dimension !== 3 || position.offset !== 0)
    throw new Error("Unsupported native intro Sprite position format");
  const raw = bytes(vd.m_DataSize), view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (count * 12 > raw.byteLength) throw new Error("Truncated native intro Sprite positions");
  const positions = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  const mapping = object(rd.uvTransform);
  const sx = finite(mapping.x), ox = finite(mapping.y), sy = finite(mapping.z), oy = finite(mapping.w);
  for (let vertex = 0; vertex < count; vertex++) {
    for (let component = 0; component < 3; component++)
      positions[vertex * 3 + component] = finite(view.getFloat32(vertex * 12 + component * 4, true));
    // Sprite's authored uvTransform maps local coordinates to pixels of its exact source texture.
    uv[vertex * 2] = (positions[vertex * 3]! * sx + ox) / textureWidth;
    uv[vertex * 2 + 1] = (positions[vertex * 3 + 1]! * sy + oy) / textureHeight;
  }
  const submeshes = rd.m_SubMeshes;
  if (!Array.isArray(submeshes) || submeshes.length !== 1) throw new Error("Native intro Sprite submesh missing");
  const submesh = object(submeshes[0]), rawIndex = bytes(rd.m_IndexBuffer);
  const start = finite(submesh.firstByte), length = finite(submesh.indexCount), base = finite(submesh.baseVertex);
  if (submesh.topology !== 0 || !Number.isSafeInteger(start) || !Number.isSafeInteger(length) ||
      !Number.isSafeInteger(base) || start < 0 || length < 0 || length % 3 || start + length * 2 > rawIndex.byteLength)
    throw new Error("Invalid native intro Sprite triangle range");
  const indexView = new DataView(rawIndex.buffer, rawIndex.byteOffset, rawIndex.byteLength);
  const indices = new Uint16Array(length);
  for (let index = 0; index < length; index++) {
    const value = base + indexView.getUint16(start + index * 2, true);
    if (value < 0 || value >= count) throw new Error("Native intro Sprite index outside vertex table");
    indices[index] = value;
  }
  const offset = object(rd.textureRectOffset), pivot = object(data.m_Pivot), border = object(data.m_Border);
  const pixelsToUnits = finite(data.m_PixelsToUnits);
  if (pixelsToUnits <= 0) throw new Error("Invalid native intro Sprite pixels per unit");
  return { positions, uv, indices, rect: rectangle(data.m_Rect), textureRect: rectangle(rd.textureRect),
    textureRectOffset: [finite(offset.x), finite(offset.y)], pivot: [finite(pivot.x), finite(pivot.y)],
    border: [finite(border.x), finite(border.y), finite(border.z), finite(border.w)], pixelsToUnits, texture: rd.texture };
}
