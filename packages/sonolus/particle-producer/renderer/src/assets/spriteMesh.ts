/**
 * Unity's tight Sprite mesh in the Sprite's logical (unpacked) coordinate
 * frame.  The vertex positions are in Sprite units (the same frame as the
 * Sprite pivot), while the indices describe the authored triangle list.
 */
export interface SpriteMesh {
  positions: ReadonlyArray<readonly [number, number, number]>;
  indices: ReadonlyArray<number>;
}

/** Validate the decoded native mesh without repairing its topology. */
export function normalizeSpriteMesh(value: unknown): SpriteMesh | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { positions, indices } = value as { positions?: unknown; indices?: unknown };
  if (!Array.isArray(positions) || positions.length < 3 || positions.length > 65535) return undefined;
  if (
    !positions.every((position) => Array.isArray(position) && position.length === 3 && position.every(Number.isFinite))
  )
    return undefined;
  if (!Array.isArray(indices) || indices.length < 3 || indices.length % 3 !== 0) return undefined;
  if (!indices.every((index) => Number.isInteger(index) && index >= 0 && index < positions.length)) return undefined;
  return { positions: positions as Array<[number, number, number]>, indices };
}
