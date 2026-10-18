import { bakeCompositeHalo, perspectiveUv, type Tile } from "./bake.ts";
import { decodeRgba8Png } from "../pack-original-note-skins.ts";
import { readFileSync } from "node:fs";
import { W_TO_H, unitsPerPixel, type ParticleSample, type QuadSample, type PlaneTransform } from "./trace.ts";

/** Bake the Source perspective interpolation into a native bilinear sprite. */
export function bakeSourceBeam(
  key: string,
  sample: ParticleSample,
  size: number,
  plane: PlaneTransform,
  aggregate?: readonly number[],
): Tile {
  const units = unitsPerPixel(size);
  const corners = sample.corners.map((p) => [p.x / units.x, p.y / units.y] as const);
  const x0 = Math.min(...corners.map((p) => p[0])),
    x1 = Math.max(...corners.map((p) => p[0]));
  const y0 = Math.min(...corners.map((p) => p[1])),
    y1 = Math.max(...corners.map((p) => p[1]));
  const quad = {
    file: sample.file,
    uv: sample.uv,
    emission: sample.emission,
    corners,
    projection: {
      originX: 0,
      originY: 0,
      alphaOrigin: plane.alpha1 - plane.slope * W_TO_H,
      alphaSlope: -plane.slope * W_TO_H * units.y,
      inverseDepths: sample.inverseDepths!,
    },
  };
  const { tile, rect } = bakeCompositeHalo(
    key,
    [quad],
    0,
    2,
    1,
    Math.min(0.25, 384 / Math.max(x1 - x0, y1 - y0)),
    1,
    true,
    2,
  );
  const image = tile.image;
  if (aggregate) {
    const source = decodeRgba8Png(readFileSync(sample.file), sample.file);
    for (let y = 0; y < image.height; y++)
      for (let x = 0; x < image.width; x++) {
        const uv = perspectiveUv(
          quad,
          rect.x0 + ((x + 0.5) / image.width) * (rect.x1 - rect.x0),
          rect.y1 - ((y + 0.5) / image.height) * (rect.y1 - rect.y0),
        );
        if (!uv) continue;
        const fx = Math.min(source.width - 1, Math.max(0, uv[0] * source.width - 0.5));
        const fy = Math.min(source.height - 1, Math.max(0, (1 - uv[1]) * source.height - 0.5));
        const sx = Math.floor(fx),
          sy = Math.floor(fy),
          dx = fx - sx,
          dy = fy - sy;
        let a = 0;
        for (const [x, y, w] of [
          [sx, sy, (1 - dx) * (1 - dy)],
          [Math.min(source.width - 1, sx + 1), sy, dx * (1 - dy)],
          [sx, Math.min(source.height - 1, sy + 1), (1 - dx) * dy],
          [Math.min(source.width - 1, sx + 1), Math.min(source.height - 1, sy + 1), dx * dy],
        ]) {
          a += (source.pixels[(y! * source.width + x!) * 4 + 3]! / 255) * w!;
        }
        const level = image.pixels[(y * image.width + x) * 4 + 3]! / 255;
        const q = Math.min(1, Math.max(0, (level - 0.55) / 0.4));
        const mask = Math.min(1, Math.max(0, (a - 0.03) / 0.07));
        const core = q * q * (3 - 2 * q) * mask * mask * (3 - 2 * mask);
        for (let c = 0; c < 3; c++) {
          const i = (y * image.width + x) * 4 + c;
          const v = image.pixels[i]! / 255;
          image.pixels[i] = Math.round(255 * (v + (Math.min(1, v * aggregate[c]!) - v) * core));
        }
      }
    const peak = Math.max(...sample.emission.map((v, c) => v * aggregate[c]!));
    for (let i = 1; i < tile.response.length - 1; i++) {
      const g = i / (tile.response.length - 1);
      const clippedPeak = Math.min(1, peak * g) / Math.max(1e-9, Math.min(1, peak));
      tile.response[i] = 0.25 * tile.response[i]! + 0.75 * clippedPeak;
    }
  }
  let left = image.width,
    top = image.height,
    right = 0,
    bottom = 0;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      if (!image.pixels[(y * image.width + x) * 4 + 3]) continue;
      left = Math.min(left, x);
      right = Math.max(right, x + 1);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y + 1);
    }
  if (right <= left || bottom <= top) return { ...tile, image: { width: 1, height: 1, pixels: new Uint8Array(4) } };
  // Keep the horizontal centre exact, allowing the outgoing native interval
  // to move offstage at its inclusive endpoint without a live x curve.
  const half = Math.max(image.width / 2 - left, right - image.width / 2);
  left = Math.max(0, Math.floor(image.width / 2 - half));
  right = Math.min(image.width, Math.ceil(image.width / 2 + half));
  const width = right - left,
    height = bottom - top;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = top; y < bottom; y++)
    pixels.set(
      image.pixels.subarray((y * image.width + left) * 4, (y * image.width + right) * 4),
      (y - top) * width * 4,
    );
  const px = (rect.x1 - rect.x0) / image.width,
    py = (rect.y1 - rect.y0) / image.height;
  const cx = rect.x0 + ((left + right) / 2) * px,
    cy = rect.y1 - ((top + bottom) / 2) * py;
  return {
    ...tile,
    image: { width, height, pixels },
    expand: [(width * px) / (x1 - x0), (height * py) / (y1 - y0)],
    offset: [(cx - (x0 + x1) / 2) / (x1 - x0), (cy - (y0 + y1) / 2) / (y1 - y0)],
  };
}

/** Expected missing additive colour, averaged after each seed's nonlinear post. */
export function sourceBeamAggregateGain(
  key: string,
  reference: ParticleSample,
  samples: readonly (QuadSample & { seed: number })[],
  size: number,
  planes: readonly PlaneTransform[],
): { gain: number[]; meanGain: number[]; percentile: number } {
  const units = unitsPerPixel(size);
  const screenQuad = (s: QuadSample) => ({
    file: s.file,
    uv: s.uv,
    emission: s.emission,
    corners: s.corners.map((p) => {
      const alpha = planes[s.plane]!.alpha1 - planes[s.plane]!.slope * W_TO_H * (p.y + 1);
      return [(p.x / units.x) * alpha, p.y / units.y] as const;
    }),
    projection: { originX: 0, originY: 0, alphaOrigin: 1, alphaSlope: 0, inverseDepths: s.inverseDepths! },
  });
  const self = screenQuad(reference);
  const field = samples.map(screenQuad);
  const allCorners = [self, ...field].flatMap((q) => q.corners);
  const left = Math.min(...allCorners.map((p) => p[0])),
    right = Math.max(...allCorners.map((p) => p[0]));
  const bottom = Math.min(...allCorners.map((p) => p[1])),
    top = Math.max(...allCorners.map((p) => p[1]));
  const grid = {
    file: reference.file,
    uv: reference.uv,
    emission: [0, 0, 0] as const,
    corners: [
      [left, bottom],
      [right, bottom],
      [right, top],
      [left, top],
    ] as const,
  };
  const own = bakeCompositeHalo(key + "|self", [self, grid], 0, 5, 1, 0.1, 1, true, 1);
  const peakAlpha = Math.max(...own.tile.image.pixels.filter((_, i) => i % 4 === 3));
  const seedSet = [...new Set(samples.map((s) => s.seed))];
  const expected = [0, 0, 0],
    baseline = [0, 0, 0];
  const ratios: number[][] = [[], [], []];
  const totals = (image: ReturnType<typeof bakeCompositeHalo>) => {
    const sum = [0, 0, 0];
    for (let y = 0; y < own.tile.image.height; y++)
      for (let x = 0; x < own.tile.image.width; x++) {
        const a = own.tile.image.pixels[(y * own.tile.image.width + x) * 4 + 3]! / 255;
        if (a < (peakAlpha / 255) * 0.8) continue;
        const px = own.rect.x0 + ((x + 0.5) / own.tile.image.width) * (own.rect.x1 - own.rect.x0);
        const py = own.rect.y1 - ((y + 0.5) / own.tile.image.height) * (own.rect.y1 - own.rect.y0);
        const ix = Math.floor(((px - image.rect.x0) / (image.rect.x1 - image.rect.x0)) * image.tile.image.width);
        const iy = Math.floor(((image.rect.y1 - py) / (image.rect.y1 - image.rect.y0)) * image.tile.image.height);
        if (ix < 0 || iy < 0 || ix >= image.tile.image.width || iy >= image.tile.image.height) continue;
        const p = (iy * image.tile.image.width + ix) * 4;
        for (let c = 0; c < 3; c++)
          sum[c]! += (image.tile.image.pixels[p + c]! * image.tile.image.pixels[p + 3]!) / 255;
      }
    return sum;
  };
  baseline.splice(0, 3, ...totals(own));
  for (const seed of seedSet) {
    const scene = bakeCompositeHalo(
      key + "|seed" + seed,
      [...samples.filter((s) => s.seed === seed).map(screenQuad), grid],
      0,
      5,
      1,
      0.1,
      1,
      true,
      1,
    );
    const sum = totals(scene);
    for (let c = 0; c < 3; c++) expected[c]! += sum[c]! / seedSet.length;
    for (let i = 0; i < own.tile.image.pixels.length; i += 4) {
      if (own.tile.image.pixels[i + 3]! < peakAlpha * 0.8) continue;
      for (let c = 0; c < 3; c++) {
        const from = own.tile.image.pixels[i + c]! * own.tile.image.pixels[i + 3]!;
        const to = scene.tile.image.pixels[i + c]! * scene.tile.image.pixels[i + 3]!;
        if (from > 0) ratios[c]!.push(to / from);
      }
    }
  }
  const meanGain = expected.map((v, c) => Math.min(3, Math.max(1, v / Math.max(1, baseline[c]!))));
  const gain = ratios.map((values) => {
    values.sort((a, b) => a - b);
    return Math.min(3, Math.max(1, values[Math.floor(values.length * 0.9)] ?? 1));
  });
  return { gain, meanGain, percentile: 0.9 };
}
