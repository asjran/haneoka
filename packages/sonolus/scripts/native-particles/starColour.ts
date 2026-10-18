import { readFileSync } from "node:fs";
import { decodeRgba8Png } from "../pack-original-note-skins.ts";
import { ease, type EaseName } from "./fit.ts";
import type { Tile } from "./bake.ts";
import type { ParticleSample } from "./trace.ts";

type Scalar = { from: { c?: number }; to: { c?: number }; ease?: EaseName };
interface CoreParticle {
  start: number;
  duration: number;
  color: string;
  a: Scalar;
}

const images = new Map<string, ReturnType<typeof decodeRgba8Png>>();

/** Source-over needs a colour and alpha response for each HDR colour interval. */
export function calibrateStarColour(
  particles: CoreParticle[],
  samples: readonly ParticleSample[],
  tile: Tile,
  progressOf: (time: number) => number,
): void {
  const first = samples[0]!;
  let image = images.get(first.file);
  if (!image) {
    image = decodeRgba8Png(readFileSync(first.file), first.file);
    images.set(first.file, image);
  }
  const unit: number[][] = [];
  const [u0, v0, u1, v1] = first.uv;
  for (let y = Math.floor((1 - v1) * image.height); y < Math.ceil((1 - v0) * image.height); y++)
    for (let x = Math.floor(u0 * image.width); x < Math.ceil(u1 * image.width); x++) {
      const p = (y * image.width + x) * 4;
      const alpha = image.pixels[p + 3]! / 255;
      if (alpha > 0) unit.push([0, 1, 2].map((c) => (image!.pixels[p + c]! / 255) * alpha));
    }
  const reference = [0, 0, 0];
  for (let p = 0; p < tile.image.pixels.length; p += 4)
    for (let c = 0; c < 3; c++) reference[c]! += (tile.image.pixels[p + c]! * tile.image.pixels[p + 3]!) / 65025;
  const flux = new Map<string, number[]>();
  const emitted = (emission: readonly number[]) => {
    const key = emission.join(",");
    let rgb = flux.get(key);
    if (!rgb) {
      rgb = [0, 0, 0];
      for (const texel of unit)
        for (let c = 0; c < 3; c++) rgb[c]! += Math.min(1, Math.max(0, texel[c]! * emission[c]!));
      flux.set(key, rgb);
    }
    return rgb;
  };
  for (const particle of particles) {
    const end = particle.start + particle.duration;
    const desired = [0, 0, 0];
    let alphaWeight = 0;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i]!;
      const t = progressOf(sample.t);
      if (t < particle.start - 1e-6 || t > end + 1e-6) continue;
      const q = Math.max(0, Math.min(1, (t - particle.start) / particle.duration));
      const a = particle.a.from.c ?? 0;
      const b = particle.a.to.c ?? 0;
      const fitted = a + (b - a) * ease(particle.a.ease ?? "linear", q);
      const before = samples[Math.max(0, i - 1)]!.t;
      const after = samples[Math.min(samples.length - 1, i + 1)]!.t;
      const weight = Math.max(1e-9, after - before) * sample.pixelArea;
      const rgb = emitted(sample.emission);
      for (let c = 0; c < 3; c++) desired[c]! += rgb[c]! * weight;
      alphaWeight += Math.max(0, fitted) * weight;
    }
    if (alphaWeight <= 1e-12) continue;
    const gains = desired.map((value, c) => value / Math.max(1e-12, reference[c]! * alphaWeight));
    const scale = Math.max(...gains);
    if (!(scale > 0)) continue;
    particle.color =
      "#" +
      gains
        .map((g) =>
          Math.round(Math.min(1, g / scale) * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("");
    particle.a = {
      ...particle.a,
      from: { c: Math.round(Math.min(1, Math.max(0, (particle.a.from.c ?? 0) * scale)) * 1000000) / 1000000 },
      to: { c: Math.round(Math.min(1, Math.max(0, (particle.a.to.c ?? 0) * scale)) * 1000000) / 1000000 },
    };
  }
}
