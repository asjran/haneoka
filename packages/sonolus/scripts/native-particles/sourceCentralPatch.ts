import { bakeRadianceFieldTile, downsamplePremultipliedTile, rasterizeProjectedRadiance, trimTile, type Tile } from "./bake.ts";
import { effectPixelOrigin, unitsPerPixel, type ParticleSample } from "./trace.ts";
import { durationBeforeNextPhase, type TrajectoryParticle } from "./trajectory.ts";

const constant = (value: number) => ({ from: { c: value }, to: { c: value }, ease: "none" });

/** Combine a co-located Source particle family before HDR clipping, retaining its display-frame clock. */
export function buildSourceCentralPatch(samples: readonly ParticleSample[], width: number, options: {
  lifetime: number; sourceScale: number; density: number; coreBloomMips: number;
}) {
  const units = unitsPerPixel(width / 4), times = [...new Set(samples.map((p) => p.t))].sort((a, b) => a - b);
  const tiles: Tile[] = [], particles: TrajectoryParticle[] = [], rows: Array<Record<string, unknown>> = [];
  for (const [index, time] of times.entries()) {
    if (time < 0 || time >= options.lifetime) continue;
    const current = samples.filter((p) => p.t === time && p.pixelArea > 0 && Math.max(...p.emission) > 0);
    if (!current.length) continue;
    const field = rasterizeProjectedRadiance(current.map((p) => ({ file: p.file, uv: p.uv, emission: p.emission,
      corners: p.corners.map((q) => [q.x / units.x, q.y / units.y] as const),
    })), options.sourceScale, options.sourceScale, effectPixelOrigin());
    let tile = bakeRadianceFieldTile(`source-central-${time}`, field, [1, 1, 1]);
    const full = bakeRadianceFieldTile(`source-central-core-${time}`, field, [1, 1, 1], 1, options.coreBloomMips, 1 / options.sourceScale);
    const pixels = new Uint8Array(tile.image.pixels);
    for (let p = 0; p < pixels.length; p += 4) {
      const alpha = pixels[p + 3]! / 255;
      if (alpha <= .5) continue;
      const coverage = Math.min(1, (alpha - .5) * 2), weight = coverage * coverage * (3 - 2 * coverage);
      for (let c = 0; c < 3; c++) {
        const current = pixels[p + c]! / 255 * alpha;
        const target = Math.min(alpha, full.image.pixels[p + c]! * full.image.pixels[p + 3]! / 65025);
        pixels[p + c] = Math.round((current + (target - current) * weight) / alpha * 255);
      }
    }
    tile = downsamplePremultipliedTile({ ...tile, image: { ...tile.image, pixels } }, options.sourceScale / options.density);
    tile = trimTile(tile);
    if (!tile.image.pixels.some((v, i) => i % 4 === 3 && v > 0)) continue;
    const r = field.rect, spanX = r.x1 - r.x0, spanY = r.y1 - r.y0;
    const x = ((r.x0 + r.x1) / 2 + tile.offset[0] * spanX) * units.x,
      y = ((r.y0 + r.y1) / 2 + tile.offset[1] * spanY) * units.y,
      w = spanX * tile.expand[0] / 2 * units.x, h = spanY * tile.expand[1] / 2 * units.y;
    const start = time / options.lifetime, end = Math.min(1, (times[index + 1] ?? options.lifetime) / options.lifetime);
    if (end <= start) continue;
    particles.push({ sprite: tiles.length, color: "#ffffff", start,
      duration: end < 1 ? durationBeforeNextPhase(start, end) : end - start,
      x: constant(x), y: constant(y), w: constant(w), h: constant(h), r: constant(0), a: constant(1) });
    tiles.push(tile);
    rows.push({ time, actors: current.map((p) => ({ system: p.system, emission: p.emission_ })),
      texture: [tile.image.width, tile.image.height], rasterArea: spanX * tile.expand[0] * spanY * tile.expand[1] });
  }
  return { tiles, group: { count: 1, particles }, rows };
}

/** Reuse a family texture only when its Source geometry is the same horizontal affine transform. */
export function shareSourceCentralPatch(master: ReturnType<typeof buildSourceCentralPatch>, reference: readonly ParticleSample[],
  target: readonly ParticleSample[], referenceWidth: number, targetWidth: number) {
  const first = target.find((p) => p.pixelWidth > 1), match = first && reference.find((p) => p.t === first.t && p.emission_ === first.emission_);
  if (!first || !match) throw new Error("Missing central Source projection sample");
  const scale = first.pixelWidth / match.pixelWidth, a = unitsPerPixel(referenceWidth / 4), b = unitsPerPixel(targetWidth / 4);
  let maximum = 0;
  for (const p of target) {
    const q = reference.find((v) => v.t === p.t && v.emission_ === p.emission_);
    if (!q) throw new Error("Central Source birth identities differ between widths");
    for (let i = 0; i < 4; i++) maximum = Math.max(maximum,
      Math.abs(p.corners[i]!.x / b.x - q.corners[i]!.x / a.x * scale),
      Math.abs(p.corners[i]!.y / b.y - q.corners[i]!.y / a.y));
  }
  if (maximum > 1e-5) throw new Error("Central Source geometry cannot share an affine patch");
  const group = structuredClone(master.group), nativeScale = scale * b.x / a.x;
  for (const p of group.particles) for (const key of ["x", "w"] as const) {
    const c = p[key] as { from: { c: number }; to: { c: number } };
    c.from.c *= nativeScale; c.to.c *= nativeScale;
  }
  return { group, maximumPixelError: maximum, pixelXScale: scale, nativeXScale: nativeScale };
}
