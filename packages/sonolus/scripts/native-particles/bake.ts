// Sprite tiles for native Sonolus particles. Sonolus draws straight-alpha
// sprites with ordinary blending and has no HDR target, so each tile carries
// the web renderer's final look for one textured quad at one emission colour:
// HDR emission (MobileAddHdrColor) plus the LiveUrpBloom halo, tone-clamped
// exactly like the composite pass, then encoded as emission-on-black.

import { readFileSync } from "node:fs";
import { decodeRgba8Png } from "../pack-original-note-skins.ts";
import { encodeRgbaPng } from "./textureBake.ts";

interface RgbaImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** LiveGameVolume Bloom: threshold 1.2 (gamma), intensity 5, scatter .7 -> .68. */
const BLOOM_THRESHOLD = Math.pow(1.2, 2.4);
const BLOOM_KNEE = BLOOM_THRESHOLD * 0.5;
const BLOOM_INTENSITY = 5;
const BLOOM_SCATTER = 0.05 + 0.9 * 0.7;
/**
 * Effective Gaussian radii (screen px at 1080p) of the five-mip pyramid. The
 * prefilter halves resolution; each later mip applies the 9-tap (sigma 3.4
 * source texels) and 5-tap (sigma 1.6 target texels) passes, i.e. about
 * 6.7 * 2^(i-1) px, accumulated in quadrature.
 */
export const BLOOM_SIGMAS = [1, 7, 15, 31, 62] as const;
/** LQ upsample: final = sum (1-s) s^i D_i, the last mip keeps s^(n-1). */
export const BLOOM_WEIGHTS = BLOOM_SIGMAS.map((_, index, list) =>
  index === list.length - 1 ? BLOOM_SCATTER ** index : (1 - BLOOM_SCATTER) * BLOOM_SCATTER ** index,
);
/**
 * Mip 0 is baked into sprites. Mip 1 is a fixed-size halo particle beside each
 * sprite (a PSF scaled by the sprite's flux); mips 2.. form one glow particle
 * per effect. Large rigs (walls, frames, pillars) bake mips 0 and 1.
 */
const SPRITE_MIPS = 1;
/** Rig halo particles bake mips 1..RIG_HALO_MIPS of the rig sprite itself. */
export const RIG_HALO_MIPS = 3;
// A per-tile halo swamps thin rig parts (the 9-slice frame borders) and seams
// between neighbouring tiles; rigs bake mip 0 and mip 1 joins the glow.
const RIG_MIPS = 1;
export const bloomPrefilter = (brightness: number): number => {
  const rq = brightness - BLOOM_THRESHOLD;
  let soft = Math.min(Math.max(rq + BLOOM_KNEE, 0), 2 * BLOOM_KNEE);
  soft = (soft * soft) / (4 * BLOOM_KNEE + 1e-4);
  return Math.max(rq, soft) / Math.max(brightness, 1e-4);
};
const RESPONSE_STEPS = 8;
/** Screen-space halo margin kept around every sprite tile. */
const bloomPad = (mips: number): number => (mips > 0 ? 2.5 * BLOOM_SIGMAS[mips - 1]! : 0);

export const SPRITE_BLOOM_MIPS = SPRITE_MIPS;
export const RIG_BLOOM_MIPS = RIG_MIPS;

export const srgbToLinear = (c: number): number => c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878);
export const linearToSrgb = (c: number): number => Math.min(1, Math.max(0, 1.055 * Math.pow(Math.abs(c), 0.416666657) - 0.055));

export interface TileRequest {
  key: string;
  file: string;
  uv: readonly [number, number, number, number];
  /** Reference HDR emission colour (includes material tint and alpha). */
  emission: readonly [number, number, number];
  /** Typical on-screen sprite height in 1080p pixels. */
  screenHeight: number;
  /** Sprite aspect on screen (width / height). */
  screenAspect: number;
  /** Bloom mips baked into the tile (0 for lane fills, drawn before bloom). */
  mips: number;
  /** First mip (a halo tile bakes mips `mipFrom..mips` without the sprite itself). */
  mipFrom?: number;
  /** Screen px per effect-camera px (1 / effectRenderingScale). */
  sigmaScale?: number;
  /** Bloom margin only on these sides (left, right, bottom, top); 9-slice joins get none. */
  padSides?: readonly [boolean, boolean, boolean, boolean];
  /** Upper bound of tile px per screen px (smooth gradients need less). */
  maxDensity?: number;
  /** Bloom calibration multiplier. */
  bloomGain: number;
}

export interface Tile {
  key: string;
  image: RgbaImage;
  /** Particle half-size multipliers covering the halo margin. */
  expand: readonly [number, number];
  /** Tile centre relative to the sprite centre, in sprite sizes (+u, +v). */
  offset: readonly [number, number];
  /** Brightness response: alpha multiplier for relative emission g in [0, 1] (RESPONSE_STEPS grid). */
  response: Float32Array;
}

const sourceCache = new Map<string, RgbaImage>();
function source(file: string): RgbaImage {
  let image = sourceCache.get(file);
  if (!image) {
    const decoded = decodeRgba8Png(readFileSync(file), file);
    image = { width: decoded.width, height: decoded.height, pixels: decoded.pixels };
    sourceCache.set(file, image);
  }
  return image;
}

/** Area-sampled crop of `uv` resized to width x height (straight RGBA floats, alpha-weighted). */
function resample(image: RgbaImage, uv: readonly number[], width: number, height: number): Float32Array {
  const [u0, v0, u1, v1] = uv as [number, number, number, number];
  // PNG row 0 is the top of the texture (v = 1).
  const x0 = u0 * image.width;
  const x1 = u1 * image.width;
  const y0 = (1 - v1) * image.height;
  const y1 = (1 - v0) * image.height;
  const out = new Float32Array(width * height * 4);
  const sx = (x1 - x0) / width;
  const sy = (y1 - y0) / height;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      const fx0 = x0 + x * sx;
      const fy0 = y0 + y * sy;
      const steps = Math.max(1, Math.ceil(Math.max(sx, sy)));
      for (let j = 0; j < steps; j += 1) {
        for (let i = 0; i < steps; i += 1) {
          const px = Math.min(image.width - 1, Math.max(0, Math.floor(fx0 + ((i + 0.5) / steps) * sx)));
          const py = Math.min(image.height - 1, Math.max(0, Math.floor(fy0 + ((j + 0.5) / steps) * sy)));
          const o = (py * image.width + px) * 4;
          const alpha = image.pixels[o + 3]! / 255;
          r += (image.pixels[o]! / 255) * alpha;
          g += (image.pixels[o + 1]! / 255) * alpha;
          b += (image.pixels[o + 2]! / 255) * alpha;
          a += alpha;
          n += 1;
        }
      }
      const o = (y * width + x) * 4;
      // Premultiplied texel.rgb * texel.a: exactly what additive blending adds.
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return out;
}

function blur(input: Float32Array, width: number, height: number, sigma: number): Float32Array {
  if (sigma < 0.3) return Float32Array.from(input);
  const radius = Math.ceil(sigma * 3);
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)));
  const sum = kernel.reduce((a, b) => a + b, 0);
  for (let i = 0; i < kernel.length; i += 1) kernel[i] = kernel[i]! / sum;
  const tmp = new Float32Array(input.length);
  const out = new Float32Array(input.length);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      for (let c = 0; c < 3; c += 1) {
        let v = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const xx = x + k;
          if (xx < 0 || xx >= width) continue;
          v += input[(y * width + xx) * 3 + c]! * kernel[k + radius]!;
        }
        tmp[(y * width + x) * 3 + c] = v;
      }
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      for (let c = 0; c < 3; c += 1) {
        let v = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const yy = y + k;
          if (yy < 0 || yy >= height) continue;
          v += tmp[(yy * width + x) * 3 + c]! * kernel[k + radius]!;
        }
        out[(y * width + x) * 3 + c] = v;
      }
  return out;
}

/** HDR emission -> final composite colour (per channel, 0..1). */
function composite(
  emission: Float32Array,
  width: number,
  height: number,
  scale: number,
  bloomGain: number,
  mips: number,
  mipFrom = 0,
  haloOnly = mipFrom > 0,
  sigmaScale = 1,
): Float32Array {
  const pixels = width * height;
  const bloom = new Float32Array(pixels * 3);
  if (mips > mipFrom) {
    const prefiltered = new Float32Array(pixels * 3);
    for (let p = 0; p < pixels; p += 1) {
      const r = emission[p * 3]!;
      const g = emission[p * 3 + 1]!;
      const b = emission[p * 3 + 2]!;
      const brightness = Math.max(r, g, b);
      const rq = brightness - BLOOM_THRESHOLD;
      let soft = Math.min(Math.max(rq + BLOOM_KNEE, 0), 2 * BLOOM_KNEE);
      soft = (soft * soft) / (4 * BLOOM_KNEE + 1e-4);
      const contribution = Math.max(rq, soft) / Math.max(brightness, 1e-4);
      prefiltered[p * 3] = r * contribution;
      prefiltered[p * 3 + 1] = g * contribution;
      prefiltered[p * 3 + 2] = b * contribution;
    }
    BLOOM_SIGMAS.slice(mipFrom, mips).forEach((sigma, offset) => {
      const index = mipFrom + offset;
      const layer = blur(prefiltered, width, height, sigma * sigmaScale * scale);
      const weight = BLOOM_WEIGHTS[index]! * BLOOM_INTENSITY * bloomGain;
      for (let i = 0; i < bloom.length; i += 1) bloom[i] = bloom[i]! + layer[i]! * weight;
    });
  }
  const out = new Float32Array(pixels * 3);
  for (let i = 0; i < out.length; i += 1)
    out[i] =
      haloOnly
        ? linearToSrgb(Math.min(1, bloom[i]!))
        : linearToSrgb(Math.min(1, srgbToLinear(Math.min(emission[i]!, 64)) + bloom[i]!));
  return out;
}

export function bakeTile(request: TileRequest): Tile {
  const image = source(request.file);
  const [u0, v0, u1, v1] = request.uv;
  const cropWidth = Math.max(1, (u1 - u0) * image.width);
  const cropHeight = Math.max(1, (v1 - v0) * image.height);
  const screenHeight = Math.max(1, request.screenHeight);
  const screenWidth = Math.max(1, screenHeight * request.screenAspect);
  const pad = bloomPad(request.mips) * (request.sigmaScale ?? 1);
  // Tile pixels per screen pixel: at least the 1080p footprint (1.5x for
  // high-DPI phones), never above the source texels, bounded tile size.
  const scale = Math.min(
    (request.mipFrom ?? 0) > 0
      ? 0.5
      : Math.min(request.maxDensity ?? 2, Math.max(1.5, Math.min(2, cropHeight / screenHeight, cropWidth / screenWidth))),
    384 / (screenHeight + 2 * pad),
    384 / (screenWidth + 2 * pad),
  );
  const spriteWidth = Math.max(2, Math.round(screenWidth * scale));
  const spriteHeight = Math.max(2, Math.round(screenHeight * scale));
  const padPixels = Math.round(pad * scale);
  const sides = request.padSides ?? [true, true, true, true];
  const padLeft = sides[0] ? padPixels : 0;
  const padRight = sides[1] ? padPixels : 0;
  const padBottom = sides[2] ? padPixels : 0;
  const padTop = sides[3] ? padPixels : 0;
  const width = spriteWidth + padLeft + padRight;
  const height = spriteHeight + padBottom + padTop;
  const texels = resample(image, request.uv, spriteWidth, spriteHeight);
  const unit = new Float32Array(width * height * 3);
  for (let y = 0; y < spriteHeight; y += 1)
    for (let x = 0; x < spriteWidth; x += 1)
      for (let c = 0; c < 3; c += 1)
        unit[((y + padTop) * width + x + padLeft) * 3 + c] = texels[(y * spriteWidth + x) * 4 + c]!;
  const withEmission = (gain: number): Float32Array => {
    const emission = new Float32Array(unit.length);
    for (let i = 0; i < unit.length; i += 1) emission[i] = unit[i]! * request.emission[i % 3]! * gain;
    return emission;
  };
  const mipFrom = request.mipFrom ?? 0;
  const final = composite(
    withEmission(1),
    width,
    height,
    scale,
    request.bloomGain,
    request.mips,
    mipFrom,
    mipFrom > 0,
    request.sigmaScale ?? 1,
  );
  let pixels = new Uint8Array(width * height * 4);
  let reference = 0;
  for (let p = 0; p < width * height; p += 1) {
    const r = final[p * 3]!;
    const g = final[p * 3 + 1]!;
    const b = final[p * 3 + 2]!;
    const alpha = Math.max(r, g, b);
    reference += r + g + b;
    pixels[p * 4] = alpha > 0 ? Math.round((r / alpha) * 255) : 0;
    pixels[p * 4 + 1] = alpha > 0 ? Math.round((g / alpha) * 255) : 0;
    pixels[p * 4 + 2] = alpha > 0 ? Math.round((b / alpha) * 255) : 0;
    pixels[p * 4 + 3] = Math.round(alpha * 255);
  }
  // Crop to the visible bounds (most effect textures are a thin shape in a
  // large transparent square); the quad follows through `offset`/`expand`.
  let x0 = width;
  let y0 = height;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      if (pixels[(y * width + x) * 4 + 3]! > 0) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x + 1 > x1) x1 = x + 1;
        if (y + 1 > y1) y1 = y + 1;
      }
  if (x1 <= x0 || y1 <= y0) {
    x0 = 0;
    y0 = 0;
    x1 = 1;
    y1 = 1;
  }
  const cropped = new Uint8Array((x1 - x0) * (y1 - y0) * 4);
  for (let y = y0; y < y1; y += 1)
    cropped.set(pixels.subarray((y * width + x0) * 4, (y * width + x1) * 4), (y - y0) * (x1 - x0) * 4);
  pixels = cropped;
  const offset: [number, number] = [
    ((x0 + x1) / 2 - (padLeft + spriteWidth / 2)) / spriteWidth,
    // Image row 0 is the sprite's +v (top) edge.
    (padTop + spriteHeight / 2 - (y0 + y1) / 2) / spriteHeight,
  ];
  // Relative brightness response on a coarse grid (bloom is recomputed per step).
  const response = new Float32Array(RESPONSE_STEPS + 1);
  response[RESPONSE_STEPS] = 1;
  for (let step = 1; step < RESPONSE_STEPS; step += 1) {
    const composed = composite(
      withEmission(step / RESPONSE_STEPS),
      width,
      height,
      scale,
      request.bloomGain,
      request.mips,
      mipFrom,
      mipFrom > 0,
      request.sigmaScale ?? 1,
    );
    let total = 0;
    for (let i = 0; i < composed.length; i += 1) total += composed[i]!;
    response[step] = reference > 0 ? Math.min(1, total / reference) : step / RESPONSE_STEPS;
  }
  return {
    key: request.key,
    image: { width: x1 - x0, height: y1 - y0, pixels },
    expand: [(x1 - x0) / spriteWidth, (y1 - y0) / spriteHeight],
    offset,
    response,
  };
}

export function responseAt(tile: Tile, g: number): number {
  const x = Math.max(0, Math.min(1, g)) * RESPONSE_STEPS;
  const i = Math.min(RESPONSE_STEPS - 1, Math.floor(x));
  const f = x - i;
  return tile.response[i]! * (1 - f) + tile.response[i + 1]! * f;
}

export interface Atlas {
  width: number;
  height: number;
  png: Buffer;
  sprites: Array<{ x: number; y: number; w: number; h: number }>;
  index: Map<string, number>;
}

/** Shelf-pack tiles (1px gutter, edge-extended) into the smallest square power of two. */
export function packAtlas(tiles: readonly Tile[]): Atlas {
  const order = tiles.map((tile, index) => ({ tile, index })).sort((a, b) => b.tile.image.height - a.tile.image.height);
  for (const size of [512, 1024, 2048, 4096]) {
    const placements = new Map<number, { x: number; y: number }>();
    let shelfY = 0;
    let shelfX = 0;
    let shelfHeight = 0;
    let overflow = false;
    for (const { tile, index } of order) {
      const w = tile.image.width + 2;
      const h = tile.image.height + 2;
      if (shelfX + w > size) {
        shelfY += shelfHeight;
        shelfX = 0;
        shelfHeight = 0;
      }
      if (w > size || shelfY + h > size) {
        overflow = true;
        break;
      }
      placements.set(index, { x: shelfX + 1, y: shelfY + 1 });
      shelfX += w;
      shelfHeight = Math.max(shelfHeight, h);
    }
    if (overflow) continue;
    const pixels = new Uint8Array(size * size * 4);
    const sprites: Atlas["sprites"] = [];
    const index = new Map<string, number>();
    tiles.forEach((tile, tileIndex) => {
      const place = placements.get(tileIndex)!;
      const { width, height } = tile.image;
      // Copy with a one-pixel extended border so bilinear filtering never
      // samples a neighbouring tile.
      for (let y = -1; y <= height; y += 1)
        for (let x = -1; x <= width; x += 1) {
          const sx = Math.min(width - 1, Math.max(0, x));
          const sy = Math.min(height - 1, Math.max(0, y));
          const from = (sy * width + sx) * 4;
          const to = ((place.y + y) * size + place.x + x) * 4;
          for (let c = 0; c < 4; c += 1) pixels[to + c] = tile.image.pixels[from + c]!;
        }
      index.set(tile.key, sprites.length);
      sprites.push({ x: place.x, y: place.y, w: width, h: height });
    });
    return { width: size, height: size, png: encodeRgbaPng({ width: size, height: size, pixels }), sprites, index };
  }
  const byKind = new Map<string, { count: number; area: number }>();
  for (const tile of tiles) {
    const kind = tile.key.startsWith("composite|") ? tile.key.split("|").slice(0, 3).join("|") : tile.key.split("|")[0]!.split("/").pop()!;
    const entry = byKind.get(kind) ?? { count: 0, area: 0 };
    entry.count += 1;
    entry.area += tile.image.width * tile.image.height;
    byKind.set(kind, entry);
  }
  const summary = [...byKind.entries()]
    .sort((a, b) => b[1].area - a[1].area)
    .map(([kind, entry]) => `${kind}: ${entry.count} tiles ${(entry.area / 1e6).toFixed(2)} MPx`);
  throw new Error(`Native particle atlas exceeds 4096x4096\n  ${summary.join("\n  ")}`);
}

/** Mean premultiplied texel colour (texel.rgb * texel.a) over a uv crop. */
export function textureCoverage(file: string, uv: readonly [number, number, number, number]): [number, number, number] {
  const texels = resample(source(file), uv, 16, 16);
  const total = [0, 0, 0];
  for (let i = 0; i < 256; i += 1) for (let c = 0; c < 3; c += 1) total[c]! += texels[i * 4 + c]!;
  return [total[0]! / 256, total[1]! / 256, total[2]! / 256];
}

/** Radial bloom kernels: the per-sprite halo (mip 1) and the per-effect glow (mips 2..). */
export interface BloomKernel {
  sigmas: readonly number[];
  weights: readonly number[];
  /** Half extent of the sprite in screen pixels. */
  extent: number;
  /** Linear radiance at the centre per unit flux (px^2), intensity included. */
  centerGain: number;
}

export const bloomKernel = (from: number, to: number, sigmaScale = 1): BloomKernel => {
  const sigmas = BLOOM_SIGMAS.slice(from, to).map((sigma) => sigma * sigmaScale);
  const weights = BLOOM_WEIGHTS.slice(from, to);
  return {
    sigmas,
    weights,
    extent: 3 * sigmas[sigmas.length - 1]!,
    centerGain: BLOOM_INTENSITY * weights.reduce((sum, weight, index) => sum + weight / (2 * Math.PI * sigmas[index]! ** 2), 0),
  };
};
export const HALO_KERNEL = bloomKernel(SPRITE_MIPS, RIG_MIPS);
export const GLOW_KERNEL = bloomKernel(SPRITE_MIPS, BLOOM_SIGMAS.length);
/** Rigs carry mips 1..RIG_HALO_MIPS in their own halo particles; the glow adds the rest. */
export const RIG_GLOW_KERNEL = bloomKernel(RIG_HALO_MIPS, BLOOM_SIGMAS.length);
/** Reference amplitude the radial tiles are baked at (sRGB shape is amplitude dependent). */
export const KERNEL_REFERENCE = 0.25;

export function bakeKernelTile(key: string, bloomKernel: BloomKernel): Tile {
  const GLOW_SIGMAS = bloomKernel.sigmas;
  const GLOW_WEIGHTS = bloomKernel.weights;
  const GLOW_EXTENT = bloomKernel.extent;
  const size = 96;
  const pixels = new Uint8Array(size * size * 4);
  // Linear profile normalised to 1 at the centre, stored at a typical 0.25 amplitude.
  const center = GLOW_WEIGHTS.reduce((sum, weight, index) => sum + weight / GLOW_SIGMAS[index]! ** 2, 0);
  const reference = linearToSrgb(KERNEL_REFERENCE);
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const dx = ((x + 0.5) / size - 0.5) * 2 * GLOW_EXTENT;
      const dy = ((y + 0.5) / size - 0.5) * 2 * GLOW_EXTENT;
      const rho2 = dx * dx + dy * dy;
      let value = 0;
      GLOW_WEIGHTS.forEach((weight, index) => {
        const sigma = GLOW_SIGMAS[index]!;
        value += (weight / sigma ** 2) * Math.exp(-rho2 / (2 * sigma * sigma));
      });
      const alpha = linearToSrgb((value / center) * KERNEL_REFERENCE) / reference;
      const o = (y * size + x) * 4;
      pixels[o] = pixels[o + 1] = pixels[o + 2] = 255;
      pixels[o + 3] = Math.round(Math.min(1, alpha) * 255);
    }
  const response = new Float32Array(RESPONSE_STEPS + 1);
  for (let step = 0; step <= RESPONSE_STEPS; step += 1) response[step] = step / RESPONSE_STEPS;
  return { key, image: { width: size, height: size, pixels }, expand: [1, 1], offset: [0, 0], response };
}

const fluxCache = new Map<string, Float32Array>();
/**
 * Prefiltered bloom flux per unit screen area of one quad: the mean over the
 * crop of prefilter(texel * emission), in linear units.
 */
export function prefilteredFlux(
  file: string,
  uv: readonly [number, number, number, number],
  emission: readonly [number, number, number],
): [number, number, number] {
  const key = `${file}|${uv.join(",")}`;
  let texels = fluxCache.get(key);
  if (!texels) fluxCache.set(key, (texels = resample(source(file), uv, 12, 12)));
  const total: [number, number, number] = [0, 0, 0];
  const count = texels.length / 4;
  for (let i = 0; i < count; i += 1) {
    const r = texels[i * 4]! * emission[0];
    const g = texels[i * 4 + 1]! * emission[1];
    const b = texels[i * 4 + 2]! * emission[2];
    const contribution = bloomPrefilter(Math.max(r, g, b));
    total[0] += r * contribution;
    total[1] += g * contribution;
    total[2] += b * contribution;
  }
  return [total[0] / count, total[1] / count, total[2] / count];
}

/** Particle alpha for a radial kernel tile at linear centre radiance `amplitude`. */
export const kernelAlpha = (amplitude: number): number =>
  Math.min(1, linearToSrgb(Math.max(0, amplitude)) / linearToSrgb(KERNEL_REFERENCE));

/** One textured quad of a composite, corners in screen pixels ((u0,v0) (u1,v0) (u1,v1) (u0,v1)). */
export interface CompositeQuad {
  file: string;
  uv: readonly [number, number, number, number];
  emission: readonly [number, number, number];
  corners: ReadonlyArray<readonly [number, number]>;
}

function sampleTexel(image: RgbaImage, u: number, v: number, out: [number, number, number]): void {
  // Bilinear, premultiplied (texel.rgb * texel.a); PNG row 0 is v = 1.
  const x = Math.min(image.width - 1, Math.max(0, u * image.width - 0.5));
  const y = Math.min(image.height - 1, Math.max(0, (1 - v) * image.height - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  out[0] = out[1] = out[2] = 0;
  for (const [px, py, w] of [
    [x0, y0, (1 - fx) * (1 - fy)],
    [x1, y0, fx * (1 - fy)],
    [x0, y1, (1 - fx) * fy],
    [x1, y1, fx * fy],
  ] as const) {
    const o = (py * image.width + px) * 4;
    const a = image.pixels[o + 3]! / 255;
    out[0] += (image.pixels[o]! / 255) * a * w;
    out[1] += (image.pixels[o + 1]! / 255) * a * w;
    out[2] += (image.pixels[o + 2]! / 255) * a * w;
  }
}

/** Inverse bilinear map of point p in quad (c0 c1 c2 c3); undefined outside. */
function inverseBilinear(
  corners: ReadonlyArray<readonly [number, number]>,
  px: number,
  py: number,
): [number, number] | undefined {
  const [a, b, c, d] = corners as [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]];
  const e = [b[0] - a[0], b[1] - a[1]];
  const f = [d[0] - a[0], d[1] - a[1]];
  const g = [a[0] - b[0] + c[0] - d[0], a[1] - b[1] + c[1] - d[1]];
  const h = [px - a[0], py - a[1]];
  const cross = (x: number[], y: number[]) => x[0]! * y[1]! - x[1]! * y[0]!;
  const k2 = cross(g, f);
  const k1 = cross(e, f) + cross(h, g);
  const k0 = cross(h, e);
  let v: number;
  if (Math.abs(k2) < 1e-9) v = -k0 / k1;
  else {
    const disc = k1 * k1 - 4 * k0 * k2;
    if (disc < 0) return undefined;
    const root = Math.sqrt(disc);
    const v1 = (-k1 - root) / (2 * k2);
    const v2 = (-k1 + root) / (2 * k2);
    v = v1 >= -1e-6 && v1 <= 1 + 1e-6 ? v1 : v2;
  }
  const denomX = e[0]! + g[0]! * v;
  const denomY = e[1]! + g[1]! * v;
  const u =
    Math.abs(denomX) > Math.abs(denomY) ? (h[0]! - f[0]! * v) / denomX : (h[1]! - f[1]! * v) / denomY;
  if (u < -1e-6 || u > 1 + 1e-6 || v < -1e-6 || v > 1 + 1e-6) return undefined;
  return [u, v];
}

/**
 * Bloom halo (mips mipFrom..mipTo) of several quads rendered together, the way
 * the effect camera sees them: emissions add, then the bloom pyramid. Returns
 * a straight-alpha tile and its rectangle in screen pixels.
 */
export function bakeCompositeHalo(
  key: string,
  quads: readonly CompositeQuad[],
  mipFrom: number,
  mipTo: number,
  bloomGain: number,
  pixelDensity = 0.25,
  sigmaScale = 1,
  includeCore = false,
  supersampleOverride?: number,
): { tile: Tile; rect: { x0: number; y0: number; x1: number; y1: number } } {
  const pad = 3 * BLOOM_SIGMAS[mipTo - 1]! * sigmaScale;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const quad of quads)
    for (const [x, y] of quad.corners) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  // Supersample the thin source geometry, then box-reduce to the tile density.
  const supersample = supersampleOverride ?? 4;
  const fine = pixelDensity * supersample;
  const width = Math.max(2, Math.ceil((maxX - minX) * pixelDensity));
  const height = Math.max(2, Math.ceil((maxY - minY) * pixelDensity));
  const fineWidth = width * supersample;
  const fineHeight = height * supersample;
  const emission = new Float32Array(width * height * 3);
  const texel: [number, number, number] = [0, 0, 0];
  for (const quad of quads) {
    const image = source(quad.file);
    const [u0, v0, u1, v1] = quad.uv;
    // Only the quad's own bounding box (swarm composites hold thousands).
    const qx0 = Math.min(...quad.corners.map(([x]) => x));
    const qx1 = Math.max(...quad.corners.map(([x]) => x));
    const qy0 = Math.min(...quad.corners.map(([, y]) => y));
    const qy1 = Math.max(...quad.corners.map(([, y]) => y));
    const fxFrom = Math.max(0, Math.floor((qx0 - minX) * fine));
    const fxTo = Math.min(fineWidth, Math.ceil((qx1 - minX) * fine) + 1);
    const fyFrom = Math.max(0, Math.floor((maxY - qy1) * fine));
    const fyTo = Math.min(fineHeight, Math.ceil((maxY - qy0) * fine) + 1);
    for (let fy = fyFrom; fy < fyTo; fy += 1)
      for (let fx = fxFrom; fx < fxTo; fx += 1) {
        // Tile rows run top to bottom; screen y grows upwards.
        const px = minX + (fx + 0.5) / fine;
        const py = maxY - (fy + 0.5) / fine;
        const st = inverseBilinear(quad.corners, px, py);
        if (!st) continue;
        sampleTexel(image, u0 + (u1 - u0) * st[0], v0 + (v1 - v0) * st[1], texel);
        const o = (Math.floor(fy / supersample) * width + Math.floor(fx / supersample)) * 3;
        const weight = 1 / (supersample * supersample);
        emission[o] = emission[o]! + texel[0] * quad.emission[0] * weight;
        emission[o + 1] = emission[o + 1]! + texel[1] * quad.emission[1] * weight;
        emission[o + 2] = emission[o + 2]! + texel[2] * quad.emission[2] * weight;
      }
  }
  const build = (gain: number): Float32Array => {
    const scaled = emission.map((value) => value * gain);
    const out = composite(scaled, width, height, pixelDensity, bloomGain, mipTo, mipFrom, !includeCore, sigmaScale);
    // Fade the last tenth of the pad so the tile border never shows.
    const fade = Math.max(1, pad * pixelDensity * 0.3);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const edge = Math.min(x + 0.5, y + 0.5, width - x - 0.5, height - y - 0.5);
        if (edge >= fade) continue;
        const k = Math.max(0, edge / fade);
        const weight = k * k * (3 - 2 * k);
        for (let c = 0; c < 3; c += 1) out[(y * width + x) * 3 + c]! *= weight;
      }
    return out;
  };
  const final = build(1);
  const pixels = new Uint8Array(width * height * 4);
  let reference = 0;
  for (let p = 0; p < width * height; p += 1) {
    const r = final[p * 3]!;
    const g = final[p * 3 + 1]!;
    const b = final[p * 3 + 2]!;
    const alpha = Math.max(r, g, b);
    reference += r + g + b;
    pixels[p * 4] = alpha > 0 ? Math.round((r / alpha) * 255) : 0;
    pixels[p * 4 + 1] = alpha > 0 ? Math.round((g / alpha) * 255) : 0;
    pixels[p * 4 + 2] = alpha > 0 ? Math.round((b / alpha) * 255) : 0;
    pixels[p * 4 + 3] = Math.round(alpha * 255);
  }
  const response = new Float32Array(RESPONSE_STEPS + 1);
  response[RESPONSE_STEPS] = 1;
  for (let step = 1; step < RESPONSE_STEPS; step += 1) {
    let total = 0;
    for (const value of build(step / RESPONSE_STEPS)) total += value;
    response[step] = reference > 0 ? Math.min(1, total / reference) : step / RESPONSE_STEPS;
  }
  return {
    tile: { key, image: { width, height, pixels }, expand: [1, 1], offset: [0, 0], response },
    rect: { x0: minX, y0: minY, x1: maxX, y1: maxY },
  };
}
