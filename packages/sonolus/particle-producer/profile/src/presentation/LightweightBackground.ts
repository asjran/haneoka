import source from "../assets/lightweight-background.json";

export interface BackgroundPixels {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array | Uint8ClampedArray;
}

export const OUR_NOTES_LIGHTWEIGHT_BACKGROUND = source;

/** FullInitialize's composite, gamma-project ARGB32 followed by RGB565. */
export function buildOurNotesLightweightBackground(
  textures: Readonly<Partial<Record<"jacket" | "baseWhite" | "stage", BackgroundPixels>>>,
): BackgroundPixels {
  const { width, height } = source;
  const composite = new Uint8Array(width * height * 4);
  const values = new Float64Array(4);
  for (const layer of source.layers) {
    const texture = textures[layer.texture as keyof typeof textures];
    const w = Math.fround(layer.size[0]! * layer.scale[0]!);
    const h = Math.fround(layer.size[1]! * layer.scale[1]!);
    const x0 = width / 2 + layer.position[0]! - w / 2;
    const y0 = height / 2 - layer.position[1]! - h / 2;
    const xMin = Math.max(0, Math.ceil(x0 - 0.5));
    const xMax = Math.min(width, Math.floor(x0 + w - 0.5) + 1);
    const yMin = Math.max(0, Math.ceil(y0 - 0.5));
    const yMax = Math.min(height, Math.floor(y0 + h - 0.5) + 1);
    for (let y = yMin; y < yMax; y++) {
      const sy = texture ? ((y + 0.5 - y0) / h) * texture.height - 0.5 : 0;
      const iy = Math.floor(sy), fy = sy - iy;
      const row0 = texture ? Math.max(0, Math.min(texture.height - 1, iy)) * texture.width * 4 : 0;
      const row1 = texture ? Math.max(0, Math.min(texture.height - 1, iy + 1)) * texture.width * 4 : 0;
      for (let x = xMin; x < xMax; x++) {
        const sx = texture ? ((x + 0.5 - x0) / w) * texture.width - 0.5 : 0;
        const ix = Math.floor(sx), fx = sx - ix;
        const col0 = texture ? Math.max(0, Math.min(texture.width - 1, ix)) * 4 : 0;
        const col1 = texture ? Math.max(0, Math.min(texture.width - 1, ix + 1)) * 4 : 0;
        const pixel = (y * width + x) * 4;
        values.fill(1);
        if (texture)
          for (let c = 0; c < 4; c++) {
            const top = texture.rgba[row0 + col0 + c]! * (1 - fx) + texture.rgba[row0 + col1 + c]! * fx;
            const bottom = texture.rgba[row1 + col0 + c]! * (1 - fx) + texture.rgba[row1 + col1 + c]! * fx;
            values[c] = (top * (1 - fy) + bottom * fy) / 255;
          }
        const alpha = values[3]! * layer.tint[3]!;
        // CompositeRectBlit uses SRC_ALPHA for both RGB and destination alpha.
        for (let c = 0; c < 4; c++)
          composite[pixel + c] = Math.round(Math.max(0, Math.min(1,
            values[c]! * layer.tint[c]! * alpha + composite[pixel + c]! / 255 * (1 - alpha),
          )) * 255);
      }
    }
  }
  const levels = [31, 63, 31];
  let rgb = new Uint16Array(width * height * 3);
  let temporary = new Uint16Array(rgb.length);
  for (let p = 0; p < width * height; p++)
    for (let c = 0; c < 3; c++) rgb[p * 3 + c] = Math.round(composite[p * 4 + c]! * levels[c]! / 255);
  const [side, center] = source.blur.weights;
  for (let iteration = 0; iteration < source.blur.iterations; iteration++)
    for (const horizontal of [true, false]) {
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const p = (y * width + x) * 3;
          const before = horizontal ? (y * width + Math.max(0, x - 1)) * 3 : (Math.max(0, y - 1) * width + x) * 3;
          const after = horizontal ? (y * width + Math.min(width - 1, x + 1)) * 3 : (Math.min(height - 1, y + 1) * width + x) * 3;
          for (let c = 0; c < 3; c++)
            temporary[p + c] = Math.round(rgb[before + c]! * side! + rgb[p + c]! * center! + rgb[after + c]! * side!);
        }
      [rgb, temporary] = [temporary, rgb];
    }
  for (let p = 0; p < width * height; p++) {
    for (let c = 0; c < 3; c++) composite[p * 4 + c] = Math.round(rgb[p * 3 + c]! * 255 / levels[c]!);
    composite[p * 4 + 3] = 255;
  }
  return { width, height, rgba: composite };
}
