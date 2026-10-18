import { bakeCompositeHalo, bakeKernelTile, bloomKernel, packAtlas, trimTile } from "./bake.ts";
import { mergeParticleGroupDelta } from "./groupDelta.ts";
import type { ParticleData } from "./merge.ts";
import { decodeRgba8Png } from "../pack-original-note-skins.ts";
import { unitsPerPixel, type ParticleSample } from "./trace.ts";
import { durationBeforeNextPhase } from "./trajectory.ts";

type Rect = { x0: number; y0: number; x1: number; y1: number };
type Atom = { samples: ParticleSample[]; rect: Rect };
export interface SourceStarHaloOptions {
  lifetime: number; sourceScale: number; mipTo: number; maximumAlpha: number; maximumAreaRatio: number;
}
const area = (r: Rect) => (r.x1 - r.x0) * (r.y1 - r.y0);
const union = (a: Rect, b: Rect): Rect => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const channel = (value: number) => ({ from: { c: value }, to: { c: value }, ease: "none" });

/** Source-derived soft light uses one shared kernel; sparse regions retain separate small quads. */
export function buildSourceStarHalos(samples: readonly ParticleSample[], width: number, options: SourceStarHaloOptions) {
  const units = unitsPerPixel(width / 4), density = .125;
  const kernel = bakeKernelTile("source-star-shared-halo", bloomKernel(1, options.mipTo, 1 / options.sourceScale), 32);
  let kernelMass = 0, kernelVariance = 0;
  for (let y = 0; y < kernel.image.height; y++) for (let x = 0; x < kernel.image.width; x++) {
    const a = kernel.image.pixels[(y * kernel.image.width + x) * 4 + 3]! / 255;
    kernelMass += a;
    kernelVariance += a * ((x + .5) / kernel.image.width * 2 - 1) ** 2;
  }
  kernelVariance /= kernelMass;
  const coverage = kernelMass / (kernel.image.width * kernel.image.height);
  const rows: Array<Record<string, unknown>> = [], particles: Array<Record<string, unknown>> = [];
  const times = [...new Set(samples.map((p) => p.t))].sort((a, b) => a - b);
  const render = (members: ParticleSample[]) => {
    const result = bakeCompositeHalo("source-star-halo-field", members.map((p) => ({ file: p.file, uv: p.uv,
      emission: p.emission, corners: p.corners.map((q) => [q.x / units.x, q.y / units.y] as const),
    })), 1, options.mipTo, 1, density, 1 / options.sourceScale, false, 4);
    const tile = trimTile(result.tile), r = result.rect;
    const cx = (r.x0 + r.x1) / 2 + tile.offset[0] * (r.x1 - r.x0),
      cy = (r.y0 + r.y1) / 2 + tile.offset[1] * (r.y1 - r.y0);
    const rect = { x0: cx - (r.x1 - r.x0) * tile.expand[0] / 2, x1: cx + (r.x1 - r.x0) * tile.expand[0] / 2,
      y0: cy - (r.y1 - r.y0) * tile.expand[1] / 2, y1: cy + (r.y1 - r.y0) * tile.expand[1] / 2 };
    return { tile, rect };
  };
  for (const [index, time] of times.entries()) {
    if (time < 0 || time >= options.lifetime) continue;
    const atoms: Atom[] = samples.filter((p) => p.t === time && p.pixelArea > 0 && Math.max(...p.emission) > 0).flatMap((p) => {
      const { tile, rect } = render([p]);
      return tile.image.pixels.some((v, i) => i % 4 === 3 && v > 0) ? [{ samples: [p], rect }] : [];
    });
    const originalArea = atoms.reduce((n, a) => n + area(a.rect), 0);
    for (;;) {
      let selected: [number, number] | undefined, best = options.maximumAreaRatio;
      for (let a = 0; a < atoms.length; a++) for (let b = a + 1; b < atoms.length; b++) {
        const ratio = area(union(atoms[a]!.rect, atoms[b]!.rect)) / (area(atoms[a]!.rect) + area(atoms[b]!.rect));
        if (ratio < best) { best = ratio; selected = [a, b]; }
      }
      if (!selected) break;
      const [a, b] = selected, left = atoms[a]!, right = atoms[b]!;
      atoms[a] = { samples: [...left.samples, ...right.samples], rect: union(left.rect, right.rect) };
      atoms.splice(b, 1);
    }
    let rasterArea = 0, energy = 0;
    for (const atom of atoms) {
      const { tile, rect } = render(atom.samples), { width: tw, height: th, pixels } = tile.image;
      const dx = (rect.x1 - rect.x0) / tw, dy = (rect.y1 - rect.y0) / th;
      let mass = 0, mx = 0, my = 0, xx = 0, yy = 0, xy = 0;
      const colour = [0, 0, 0];
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const p = (y * tw + x) * 4, alpha = pixels[p + 3]! / 255;
        const rgb = [0, 1, 2].map((c) => pixels[p + c]! / 255 * alpha);
        const w = rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722;
        const px = (rect.x0 + (x + .5) * dx) * units.x, py = (rect.y1 - (y + .5) * dy) * units.y;
        mass += w; mx += w * px; my += w * py; xx += w * px * px; yy += w * py * py; xy += w * px * py;
        for (let c = 0; c < 3; c++) colour[c]! += rgb[c]! * dx * dy;
      }
      if (mass <= 0) continue;
      mx /= mass; my /= mass;
      const a = Math.max(0, xx / mass - mx * mx), b = xy / mass - mx * my, c = Math.max(0, yy / mass - my * my),
        spread = Math.hypot(a - c, 2 * b), angle = .5 * Math.atan2(2 * b, a - c),
        hw = Math.sqrt(Math.max(1e-12, (a + c + spread) / 2) / kernelVariance),
        hh = Math.sqrt(Math.max(1e-12, (a + c - spread) / 2) / kernelVariance),
        quadArea = 4 * hw * hh / (units.x * units.y), peak = Math.max(...colour),
        alpha = Math.min(options.maximumAlpha, peak / Math.max(1e-12, quadArea * coverage));
      const start = time / options.lifetime, end = Math.min(1, (times[index + 1] ?? options.lifetime) / options.lifetime);
      if (end <= start || alpha <= 0) continue;
      particles.push({ sprite: 0, color: "#" + colour.map((v) => Math.round(v / peak * 255).toString(16).padStart(2, "0")).join(""),
        start, duration: end < 1 ? durationBeforeNextPhase(start, end) : end - start,
        x: channel(mx), y: channel(my), w: channel(hw), h: channel(hh), r: channel(angle), a: channel(alpha) });
      rasterArea += quadArea; energy += mass * dx * dy;
    }
    rows.push({ time, sourceActors: atoms.reduce((n, a) => n + a.samples.length, 0), quads: atoms.length,
      originalSmallBoundsArea: originalArea, clusterBoundsArea: atoms.reduce((n, a) => n + area(a.rect), 0), rasterArea, energy });
  }
  return { tile: kernel, group: { count: 1, particles }, rows };
}

/** Add the shared soft-light carrier to the existing background pass; no engine instance is added. */
export function appendSourceStarHalos(data: ParticleData, png: Buffer, samples: readonly ParticleSample[], width: number,
  effectName: string, options: SourceStarHaloOptions) {
  const halo = buildSourceStarHalos(samples, width, options);
  const background = data.effects.find((effect) => effect.name === effectName);
  if (!background) throw new Error(`Source star halo requires the background effect: ${effectName}`);
  const result = mergeParticleGroupDelta(data, png, {
    effects: [{ ...background, groups: [halo.group] }], atlas: packAtlas([halo.tile]),
  }, new Set(), decodeRgba8Png, true);
  return { ...result, proof: { effect: effectName, definitions: halo.group.particles.length,
    groups: 1, addedNativeInstances: 0, tile: [halo.tile.image.width, halo.tile.image.height], options, rows: halo.rows } };
}
