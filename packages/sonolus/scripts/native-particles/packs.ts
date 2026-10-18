import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Atlas, Tile } from "./bake.ts";
import { decodePng, encodeRgbaPng } from "./textureBake.ts";
import { packRectangles } from "./rectanglePacking.ts";
import type { ParticleData } from "./merge.ts";
import {
  NATIVE_PARTICLE_PACKS,
  NATIVE_PARTICLE_SEMANTIC_PREFIX,
  NATIVE_PARTICLE_SIMPLE_CAPABILITY,
} from "../../src/shared/particlePacks.ts";

type Json = Record<string, unknown>;
const digest = (data: Buffer) => createHash("sha1").update(data).digest("hex");

/** Refresh final resource identities after geometry, material and lifetime stages. */
export function refreshNativeParticlePackReports(directory: string) {
  const manifestPath = resolve(directory, "particle-packs.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { packs: Json[] };
  for (const { key } of NATIVE_PARTICLE_PACKS) {
    const root = resolve(directory, "particles", key);
    const bytes = readFileSync(resolve(root, "particle.data"));
    const png = readFileSync(resolve(root, "particle.texture.png"));
    const data = JSON.parse(gunzipSync(bytes).toString()) as ParticleData;
    const effects = data.effects as Array<{ groups: Array<{ count: number; particles: unknown[] }> }>;
    const reportPath = resolve(root, "particle-pack-report.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Json;
    Object.assign(report, {
      effects: effects.length,
      groups: effects.reduce((sum, effect) => sum + effect.groups.length, 0),
      instances: effects.reduce((sum, effect) => sum + effect.groups.reduce((n, group) => n + group.count, 0), 0),
      definitions: effects.reduce((sum, effect) => sum + effect.groups.reduce((n, group) => n + group.particles.length, 0), 0),
      atlas: { width: data.width, height: data.height, sprites: data.sprites.length },
      artifacts: { data: { bytes: bytes.length, sha1: digest(bytes) }, texture: { bytes: png.length, sha1: digest(png) } },
    });
    const entry = manifest.packs.find((entry) => entry.key === key);
    if (!entry) throw new Error(`Missing final particle manifest entry: ${key}`);
    Object.assign(entry, report);
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}
const zero = (expression: unknown): boolean =>
  typeof expression === "object" && expression !== null && Object.values(expression).every((value) => value === 0);
function upperBound(expression: unknown): number | undefined {
  if (!expression || typeof expression !== "object") return undefined;
  let upper = 0;
  for (const [name, raw] of Object.entries(expression)) {
    if (typeof raw !== "number") return undefined;
    if (name === "c") upper += raw;
    else if (/^r[1-8]$/.test(name)) upper += Math.max(0, raw);
    else if (/^(sinr|cosr)[1-8]$/.test(name)) upper += Math.abs(raw);
    else return undefined;
  }
  return upper;
}
function invisible(particle: Json): boolean {
  for (const name of ["w", "h"]) {
    const channel = particle[name] as Json | undefined;
    if (channel && zero(channel.from) && zero(channel.to)) return true;
  }
  const alpha = particle.a as Json | undefined;
  if (!alpha || !/^(none|linear|(in|out|inOut|outIn)(Sine|Quad|Cubic|Quart|Quint|Expo|Circ))$/.test(String(alpha.ease)))
    return false;
  const from = upperBound(alpha.from),
    to = upperBound(alpha.to);
  return from !== undefined && to !== undefined && Math.max(from, to) <= 0;
}

function constantChannels(particle: Json): Json {
  const result = { ...particle };
  for (const name of ["x", "y", "w", "h", "r", "a"]) {
    const channel = particle[name] as Json;
    const from = channel.from as Record<string, number>;
    const to = channel.to as Record<string, number>;
    if (
      Object.keys(from).length === Object.keys(to).length &&
      Object.entries(from).every(([key, value]) => to[key] === value)
    )
      result[name] = { ...channel, ease: "none" };
  }
  return result;
}

function symmetricTrim(image: ReturnType<typeof decodePng>, sprite: ParticleData["sprites"][number]) {
  let x0 = sprite.w,
    y0 = sprite.h,
    x1 = 0,
    y1 = 0;
  for (let y = 0; y < sprite.h; y++)
    for (let x = 0; x < sprite.w; x++) {
      const offset = ((sprite.y + y) * image.width + sprite.x + x) * 4;
      if (!image.pixels.subarray(offset, offset + 4).some((value) => value !== 0)) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + 1);
      y1 = Math.max(y1, y + 1);
    }
  const empty = x1 <= x0;
  // Retain two transparent texels for filtering; equal margins keep the
  // centre, signed sizes and rotation channels unchanged.
  const x = empty ? 0 : Math.max(0, Math.min(x0, sprite.w - x1) - 2);
  const y = empty ? 0 : Math.max(0, Math.min(y0, sprite.h - y1) - 2);
  return { x, y, w: sprite.w - 2 * x, h: sprite.h - 2 * y, empty };
}

function scaleChannel(channel: Json, scale: number): Json {
  if (scale === 1) return channel;
  return {
    ...channel,
    ...Object.fromEntries(
      ["from", "to"].map((side) => [
        side,
        Object.fromEntries(
          Object.entries(channel[side] as Record<string, number>).map(([key, value]) => [key, value * scale]),
        ),
      ]),
    ),
  };
}

function packProfileAtlas(tiles: readonly Tile[]): Atlas {
  const rectangles = tiles.map((tile) => ({ width: tile.image.width + 2, height: tile.image.height + 2 }));
  for (const size of [512, 1024, 2048, 4096]) {
    const placements = packRectangles(rectangles, size);
    if (!placements) continue;
    const pixels = new Uint8Array(size * size * 4);
    const sprites: Atlas["sprites"] = [];
    const index = new Map<string, number>();
    tiles.forEach((tile, tileIndex) => {
      const place = placements[tileIndex]!;
      const { width, height } = tile.image;
      const x0 = place.x + 1,
        y0 = place.y + 1;
      for (let y = -1; y <= height; y++)
        for (let x = -1; x <= width; x++) {
          const sx = Math.min(width - 1, Math.max(0, x));
          const sy = Math.min(height - 1, Math.max(0, y));
          const from = (sy * width + sx) * 4;
          const to = ((y0 + y) * size + x0 + x) * 4;
          for (let channel = 0; channel < 4; channel++) pixels[to + channel] = tile.image.pixels[from + channel]!;
        }
      index.set(tile.key, sprites.length);
      sprites.push({ x: x0, y: y0, w: width, h: height });
    });
    return { width: size, height: size, sprites, index, png: encodeRgbaPng({ width: size, height: size, pixels }) };
  }
  throw new Error("Native particle profile atlas exceeds 4096x4096");
}

/** Each item owns one profile and an atlas containing only its referenced RGBA tiles. */
export function writeNativeParticlePacks(source: ParticleData, png: Buffer, directory: string, decode = decodePng) {
  const sourceFiles = {
    "packages/sonolus/scripts/native-particles/packs.ts": new URL("./packs.ts", import.meta.url),
    "packages/sonolus/scripts/native-particles/rectanglePacking.ts": new URL("./rectanglePacking.ts", import.meta.url),
    "packages/sonolus/src/shared/particlePacks.ts": new URL("../../src/shared/particlePacks.ts", import.meta.url),
  };
  const sourceHashes = Object.fromEntries(
    Object.entries(sourceFiles).map(([path, file]) => [
      path,
      createHash("sha256").update(readFileSync(file)).digest("hex"),
    ]),
  );
  const image = decode(png, "native particle atlas");
  const trims = source.sprites.map((sprite) => symmetricTrim(image, sprite));
  const zeroSprites = new Set(trims.flatMap((trim, index) => (trim.empty ? [index] : [])));
  const reports = [];
  for (const pack of NATIVE_PARTICLE_PACKS) {
    let removedInvisible = 0,
      removedEmptyGroups = 0;
    const omittedEmptyEffects: string[] = [];
    const effects: Array<Json & { name: string; groups: Json[] }> = source.effects
      .filter((effect) => {
        const name = effect.name as string;
        return name.startsWith(pack.prefix + " ") || name.startsWith("Our Notes Lane ");
      })
      .flatMap((effect) => {
        const name = (effect.name as string).replace(pack.prefix, NATIVE_PARTICLE_SEMANTIC_PREFIX);
        const groups = (effect.groups as Json[]).flatMap((group) => {
          const particles = (group.particles as Json[])
            .filter((particle) => {
              if (!zeroSprites.has(particle.sprite as number) && !invisible(particle)) return true;
              removedInvisible++;
              return false;
            })
            .map((particle) => {
              const index = particle.sprite as number;
              const original = source.sprites[index]!;
              const trim = trims[index]!;
              return constantChannels({
                ...particle,
                w: scaleChannel(particle.w as Json, trim.w / original.w),
                h: scaleChannel(particle.h as Json, trim.h / original.h),
              });
            });
          if (!particles.length) {
            removedEmptyGroups++;
            return [];
          }
          return [{ ...group, particles }];
        });
        if (!groups.length) {
          omittedEmptyEffects.push(name);
          return [];
        }
        return [{ ...effect, name, groups }];
      });
    const used = new Set<number>();
    for (const effect of effects)
      for (const group of effect.groups as Json[])
        for (const particle of group.particles as Json[]) used.add(particle.sprite as number);
    if (pack.key === "simple") {
      const constant = (value: number) => ({ from: { c: value }, to: { c: value }, ease: "none" });
      effects.push({
        name: NATIVE_PARTICLE_SIMPLE_CAPABILITY,
        groups: [
          {
            count: 1,
            particles: [
              {
                sprite: used.values().next().value!,
                color: "#ffffff",
                start: 0,
                duration: 1,
                x: constant(0),
                y: constant(0),
                w: constant(1),
                h: constant(1),
                r: constant(0),
                a: constant(0),
              },
            ],
          },
        ],
        transform: Object.fromEntries(
          ["x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"].map((name) => [name, { [name]: 1 }]),
        ),
      });
    }
    const tiles: Tile[] = [...used]
      .sort((a, b) => a - b)
      .map((index) => {
        const sprite = source.sprites[index]!;
        const trim = trims[index]!;
        const pixels = new Uint8Array(trim.w * trim.h * 4);
        for (let y = 0; y < trim.h; y++) {
          const start = ((sprite.y + trim.y + y) * image.width + sprite.x + trim.x) * 4;
          pixels.set(image.pixels.subarray(start, start + trim.w * 4), y * trim.w * 4);
        }
        return {
          key: `${index}`,
          image: { width: trim.w, height: trim.h, pixels },
          expand: [1, 1],
          offset: [0, 0],
          response: new Float32Array(),
        };
      });
    const atlas = packProfileAtlas(tiles);
    for (const effect of effects)
      for (const group of effect.groups as Json[])
        for (const particle of group.particles as Json[]) particle.sprite = atlas.index.get(`${particle.sprite}`)!;
    const data = {
      width: atlas.width,
      height: atlas.height,
      interpolation: source.interpolation,
      sprites: atlas.sprites,
      effects,
    };
    const bytes = gzipSync(JSON.stringify(data), { level: 9 });
    const out = resolve(directory, "particles", pack.key);
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "particle.data"), bytes);
    writeFileSync(resolve(out, "particle.texture.png"), atlas.png);
    const report = {
      key: pack.key,
      name: pack.name,
      sourcePrefix: pack.prefix,
      semanticPrefix: NATIVE_PARTICLE_SEMANTIC_PREFIX,
      effects: effects.length,
      omittedEmptyEffects,
      removedInvisible,
      removedEmptyGroups,
      zeroRgbaSprites: zeroSprites.size,
      symmetricTrim: {
        guardPixels: 2,
        sprites: [...used].filter((index) => trims[index]!.x || trims[index]!.y).length,
        texelsBefore: [...used].reduce((sum, index) => sum + source.sprites[index]!.w * source.sprites[index]!.h, 0),
        texelsAfter: [...used].reduce((sum, index) => sum + trims[index]!.w * trims[index]!.h, 0),
      },
      groups: effects.reduce((n, e) => n + e.groups.length, 0),
      instances: effects.reduce((n, e) => n + e.groups.reduce((t, g) => t + (g.count as number), 0), 0),
      definitions: effects.reduce((n, e) => n + e.groups.reduce((t, g) => t + (g.particles as Json[]).length, 0), 0),
      atlas: { width: atlas.width, height: atlas.height, sprites: atlas.sprites.length },
      artifacts: {
        data: { bytes: bytes.length, sha1: digest(bytes) },
        texture: { bytes: atlas.png.length, sha1: digest(atlas.png) },
      },
    };
    writeFileSync(resolve(out, "particle-pack-report.json"), JSON.stringify(report, null, 2) + "\n");
    reports.push(report);
  }
  for (const [path, file] of Object.entries(sourceFiles))
    if (createHash("sha256").update(readFileSync(file)).digest("hex") !== sourceHashes[path])
      throw new Error(`Input changed during particle packing: ${path}`);
  writeFileSync(
    resolve(directory, "particle-packs.json"),
    JSON.stringify(
      {
        schema: "our-notes-particle-packs-v1",
        sourceDataSha256: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
        sourceTextureSha256: createHash("sha256").update(png).digest("hex"),
        sourceHashes,
        packs: reports,
      },
      null,
      2,
    ) + "\n",
  );
  return reports;
}
