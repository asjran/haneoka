// Effect texture baking: fold the Unity MobileAddHdrColor material math into
// straight-alpha atlas tiles so Sonolus' additive particle rendering
// reproduces the authored look, then shelf-pack a small power-of-two atlas.
// The compiled shader renders texel.rgb * 2 * tintRGB^2 against
// texel.a * 2 * tintA^2; clamping to 1.0 is the only loss.

import { deflateSync, inflateSync } from "node:zlib";

export interface RgbaImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

interface PngChunk {
  type: string;
  data: Buffer;
}

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index]!;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function decodePng(input: Buffer, sourceName: string): RgbaImage {
  if (input.readUInt32BE(0) !== 0x89504e47) throw new Error(`${sourceName}: not a PNG`);
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset + 8 <= input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.subarray(offset + 4, offset + 8).toString("ascii");
    chunks.push({ type, data: input.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
    if (type === "IEND") break;
  }
  const header = chunks.find((chunk) => chunk.type === "IHDR")?.data;
  if (!header || header.length < 13) throw new Error(`${sourceName}: missing IHDR`);
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bitDepth = header[8]!;
  const colorType = header[9]!;
  const interlace = header[12]!;
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0)
    throw new Error(`${sourceName}: expected 8-bit RGBA PNG (got depth ${bitDepth} type ${colorType})`);
  const compressed = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));
  const raw = inflateAll(compressed, width, height);
  const pixels = new Uint8Array(width * height * 4);
  const stride = width * 4;
  for (let y = 0; y < height; y += 1) {
    const row = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    pixels.set(row, y * stride);
  }
  return { width, height, pixels };
}

function inflateAll(compressed: Buffer, width: number, height: number): Buffer {
  void width;
  void height;
  return inflateSync(compressed);
}

function encodeChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

export function encodeRgbaPng(image: RgbaImage): Buffer {
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(image.pixels.subarray(y * stride, y * stride + stride)).copy(raw, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    encodeChunk("IHDR", header),
    encodeChunk("IDAT", deflateSync(raw, { level: 9 })),
    encodeChunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface TileSource {
  key: string;
  image: RgbaImage;
  /** Authored MobileAddHdrColor tint; applied per particle color, not per tile. */
  tint: readonly [number, number, number, number];
  /** Optional additive halo approximating the game's bloom. */
  glow: number;
}

export interface PackedTile {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  spriteIndex: number;
}

const applyTintAndGlow = (source: TileSource): RgbaImage => {
  // Tiles carry the authored texels untouched: the MobileAddHdrColor tint and
  // its HDR doubling fold into each particle's `color` field instead (the
  // tile-side clamp would otherwise crush the per-system start colors).
  const { width, height, pixels } = source.image;
  void source.tint;
  const baked = new Float32Array(width * height * 4);
  // ef_wall's alpha is a 128-level DITHERED gradient (mobile-shader trick).
  // A flat quad sampling it raw shows the dither as noise, so the wall tile
  // is re-baked as the per-row average: the authored vertical gradient shape
  // (bright near the judgement line, fading upward) without the dither.
  const rowAlpha = new Float32Array(height);
  if (source.key === "wall") {
    for (let y = 0; y < height; y += 1) {
      let total = 0;
      for (let x = 0; x < width; x += 1) total += pixels[(y * width + x) * 4 + 3]!;
      rowAlpha[y] = total / width / 255;
    }
  }
  for (let index = 0; index < width * height; index += 1) {
    const o = index * 4;
    // Several effect textures are pure alpha masks (shape in A, RGB=0); the
    // game shader multiplies them by bright HDR colors, so black RGB here
    // means "use the alpha as the emission shape intensity", not black light.
    let r = pixels[o]! / 255;
    let g = pixels[o + 1]! / 255;
    let b = pixels[o + 2]! / 255;
    let alpha = pixels[o + 3]! / 255;
    if (Math.max(r, g, b) < 8 / 255) r = g = b = alpha;
    if (source.key === "wall") {
      const y = Math.floor(index / width);
      alpha = Math.min(1, rowAlpha[y]! * 2.2);
      r = g = b = alpha;
    }
    baked[o] = r;
    baked[o + 1] = g;
    baked[o + 2] = b;
    baked[o + 3] = alpha;
  }
  if (source.glow > 0) {
    const blurred = boxBlur3(baked, width, height, Math.max(2, Math.round(Math.min(width, height) / 10)));
    const k = source.glow;
    for (let index = 0; index < baked.length; index += 4) {
      baked[index] = Math.min(1, baked[index]! + blurred[index]! * k);
      baked[index + 1] = Math.min(1, baked[index + 1]! + blurred[index + 1]! * k);
      baked[index + 2] = Math.min(1, baked[index + 2]! + blurred[index + 2]! * k);
      baked[index + 3] = Math.min(1, baked[index + 3]! + blurred[index + 3]! * k * 0.7);
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let index = 0; index < baked.length; index += 1) out[index] = Math.round(clamp01(baked[index]!) * 255);
  return { width, height, pixels: out };
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function boxBlur3(buffer: Float32Array, width: number, height: number, radius: number): Float32Array {
  const channels = 4;
  const temp = new Float32Array(buffer.length);
  const out = new Float32Array(buffer.length);
  const window = radius * 2 + 1;
  for (let pass = 0; pass < 3; pass += 1) {
    const source = pass === 0 ? buffer : out;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        for (let c = 0; c < channels; c += 1) {
          let sum = 0;
          for (let d = -radius; d <= radius; d += 1) {
            const sx = Math.max(0, Math.min(width - 1, x + d));
            sum += source[(y * width + sx) * channels + c]!;
          }
          temp[(y * width + x) * channels + c] = sum / window;
        }
      }
    }
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        for (let c = 0; c < channels; c += 1) {
          let sum = 0;
          for (let d = -radius; d <= radius; d += 1) {
            const sy = Math.max(0, Math.min(height - 1, y + d));
            sum += temp[(sy * width + x) * channels + c]!;
          }
          out[(y * width + x) * channels + c] = sum / window;
        }
      }
    }
  }
  return out;
}

export interface AtlasResult {
  width: number;
  height: number;
  png: Buffer;
  tiles: PackedTile[];
  spriteIndexOf: ReadonlyMap<string, number>;
}

/** Shelf-pack tinted tiles with a 2px gutter into the smallest power-of-two atlas. */
export function bakeAtlas(sources: readonly TileSource[]): AtlasResult {
  const baked = sources.map((source) => ({ source, image: applyTintAndGlow(source) }));
  baked.sort((a, b) => b.image.height - a.image.height);
  for (const size of [1024, 2048, 4096] as const) {
    const shelves: Array<{ y: number; h: number; x: number }> = [];
    const placements: Array<{ x: number; y: number }> = [];
    let overflow = false;
    for (const entry of baked) {
      const w = entry.image.width + 2;
      const h = entry.image.height + 2;
      if (w > size || h > size) {
        overflow = true;
        break;
      }
      let shelf = shelves.find((candidate) => candidate.h >= h && size - candidate.x >= w);
      if (!shelf) {
        shelf = { x: 0, h, y: shelves.reduce((total, current) => total + current.h, 0) };
        shelves.push(shelf);
      }
      placements.push({ x: shelf.x + 1, y: shelf.y + 1 });
      shelf.x += w;
      if (shelf.y + h > size) overflow = true;
    }
    if (overflow) continue;
    const pixels = new Uint8Array(size * size * 4);
    const tiles: PackedTile[] = [];
    const spriteIndexOf = new Map<string, number>();
    baked.forEach((entry, index) => {
      const place = placements[index]!;
      for (let y = 0; y < entry.image.height; y += 1) {
        const from = y * entry.image.width * 4;
        pixels.set(entry.image.pixels.subarray(from, from + entry.image.width * 4), ((place.y + y) * size + place.x) * 4);
      }
      spriteIndexOf.set(entry.source.key, index);
      tiles.push({ key: entry.source.key, x: place.x, y: place.y, w: entry.image.width, h: entry.image.height, spriteIndex: index });
    });
    return {
      width: size,
      height: size,
      png: encodeRgbaPng({ width: size, height: size, pixels }),
      tiles,
      spriteIndexOf,
    };
  }
  throw new Error("effect texture atlas capacity exceeded");
}
