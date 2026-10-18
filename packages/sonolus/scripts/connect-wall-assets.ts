import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  bakeRadianceFieldTile,
  fitHdrCarrierSamples,
  hdrCarrierPairFromTiles,
  packAtlas,
  rasterizeProjectedRadiance,
  splitConstantTileColumns,
  trimTile,
  type CompositeQuad,
  type Tile,
} from "./native-particles/bake.ts";
import { EffectTracer, effectPixelOrigin, unitsPerPixel, W_TO_H } from "./native-particles/trace.ts";
import { repackParticleAtlas } from "./native-particles/repack.ts";
import { decodeRgba8Png } from "./pack-original-note-skins.ts";
import { refreshNativeParticlePackReports } from "./native-particles/packs.ts";
import type { ParticleData } from "./native-particles/merge.ts";

import {
  CONNECT_WALL_LEVEL_COUNT as LEVELS,
  connectWallLevelEnergy as levelEnergy,
  connectWallEffectTable,
} from "../../../.dependencies/sonolus-our-notes/shared/src/engine/data/connectWallContract.ts";
const channel = (c: number) => ({ from: { c }, to: { c }, ease: "none" });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const BACKGROUND = [10 / 255, 22 / 255, 49 / 255] as const;

/** One shared wall per geometry; finite energy definitions reuse the same HDR body/core textures. */
export async function buildConnectWallAggregateAssets(options: {
  destination: string;
  baseline: string;
  releaseRoot: string;
  contractFile: string;
  maximumAtlasHeight?: number;
}) {
  if (resolve(options.baseline) !== resolve(options.destination))
    cpSync(options.baseline, options.destination, { recursive: true });
  const contract = JSON.parse(readFileSync(options.contractFile, "utf8")) as {
    nativeEffects: { planes: Array<{ alpha1: number; slope: number }> };
  };
  const reports = [];
  for (const [profile, quality, skin] of [
    ["standard", 0, "effect001"],
    ["light", 2, "effect001"],
    ["simple", 0, "effect001Simple"],
  ] as const) {
    const directory = resolve(options.destination, "particles", profile);
    const data = JSON.parse(gunzipSync(readFileSync(resolve(directory, "particle.data"))).toString()) as ParticleData;
    const png = readFileSync(resolve(directory, "particle.texture.png"));
    const original = decodeRgba8Png(png, "Connect aggregate input");
    const tracer = new EffectTracer({
      releaseRoot: options.releaseRoot,
      currentQuality: quality,
      noteEffectSkin: skin,
    });
    await tracer.load();
    const peakAge = profile === "simple" ? 0.05833333333333333 : 0.075;
    const traced = tracer.trace(
      { kind: "connect", direction: "none", judgement: "perfect", lifetime: 7 / 12 },
      8,
      [peakAge],
      [4660],
      { particle: () => false },
    );
    const units = unitsPerPixel(2),
      targetPlane = contract.nativeEffects.planes[1]!;
    const alphaAt = (plane: { alpha1: number; slope: number }, y: number) =>
      plane.alpha1 - plane.slope * W_TO_H - plane.slope * W_TO_H * units.y * y;
    const quads: CompositeQuad[] = [...traced.meshes]
      .filter(([name]) => name.startsWith("wall#"))
      .map(([, samples]) => {
        const sample = samples[0]!,
          sourcePlane = contract.nativeEffects.planes[sample.plane]!;
        return {
          file: sample.file,
          uv: sample.uv,
          emission: sample.emission,
          corners: sample.corners.map(({ x, y }) => {
            const px = x / units.x,
              py = y / units.y;
            return [(px * alphaAt(sourcePlane, py)) / alphaAt(targetPlane, py), py] as [number, number];
          }),
          projection: {
            originX: 0,
            originY: 0,
            alphaOrigin: targetPlane.alpha1 - targetPlane.slope * W_TO_H,
            alphaSlope: -targetPlane.slope * W_TO_H * units.y,
            inverseDepths: sample.inverseDepths!,
          },
        };
      });
    if (!quads.length) throw new Error("Formal Connect wall geometry missing");
    const sourceDensity = tracer.assets.liveQuality.effectRenderingScale;
    const field = rasterizeProjectedRadiance(quads, sourceDensity, 0.25, effectPixelOrigin(), 3);
    const virtualCache = new Map<number, Tile>();
    const virtualAt = (energy: number): Tile => {
      const cached = virtualCache.get(energy);
      if (cached) return cached;
      const tile = bakeRadianceFieldTile("connect-wall", field, [energy, energy, energy], 1, 1);
      const pixels = new Uint8Array(tile.image.pixels.length);
      for (let p = 0; p < pixels.length; p += 4) {
        const values = [0, 1, 2].map((c) =>
          Math.min(1, (tile.image.pixels[p + c]! * tile.image.pixels[p + 3]!) / 65025 / (1 - BACKGROUND[c]!)),
        );
        const alpha = Math.max(...values);
        for (let c = 0; c < 3; c++) pixels[p + c] = alpha > 0 ? Math.round((values[c]! / alpha) * 255) : 0;
        pixels[p + 3] = Math.round(alpha * 255);
      }
      const result = { ...tile, image: { ...tile.image, pixels } };
      virtualCache.set(energy, result);
      return result;
    };
    const maximum = levelEnergy(LEVELS - 1);
    const anchors = [0, 0.25, 0.5, 1, 2, 4, 2 ** 2.5, 8, 16, maximum];
    const ranges = anchors.slice(1).map((high, range) => {
      const low = anchors[range]!;
      const pair = hdrCarrierPairFromTiles(
        "aggregate-connect|" + range,
        low / high,
        virtualAt(low).image,
        virtualAt(high).image,
      );
      const responses = fitHdrCarrierSamples(
        pair,
        (_q, i) => virtualAt(Math.max(low, Math.min(high, levelEnergy(i)))).image.pixels,
        LEVELS - 1,
        (q) => levelEnergy(Math.round(q * (LEVELS - 1))) / high,
        true,
      );
      return { low, high, pair, responses };
    });
    const tiles: Tile[] = [],
      indices = new Map<string, number>();
    const register = (tile: Tile) => {
      const key = `${tile.image.width}:${tile.image.height}:${hash(tile.image.pixels)}`;
      const existing = indices.get(key);
      if (existing !== undefined) return existing;
      const id = tiles.length;
      tiles.push(tile);
      indices.set(key, id);
      return id;
    };
    const copiedSprites = new Map<number, number>();
    for (const effect of data.effects)
      for (const group of effect.groups as Array<{ particles: Array<{ sprite: number }> }>)
        for (const particle of group.particles) {
          const id = particle.sprite;
          let copied = copiedSprites.get(id);
          if (copied === undefined) {
            const s = data.sprites[id]!,
              pixels = new Uint8Array(s.w * s.h * 4);
            for (let y = 0; y < s.h; y++)
              pixels.set(
                original.pixels.subarray(
                  ((s.y + y) * original.width + s.x) * 4,
                  ((s.y + y) * original.width + s.x + s.w) * 4,
                ),
                y * s.w * 4,
              );
            copied = register({
              key: "original",
              image: { width: s.w, height: s.h, pixels },
              expand: [1, 1],
              offset: [0, 0],
              response: new Float32Array(9).fill(1),
            });
            copiedSprites.set(id, copied);
          }
          particle.sprite = copied;
        }
    const carriers = ranges.map(({ pair }) =>
      [pair.body, pair.core].map((source) => {
        if (!source || !source.image.pixels.some((value, i) => i % 4 === 3 && value > 0)) return [];
        const pixels = new Uint8Array(source.image.pixels);
        for (let p = 0; p < pixels.length; p += 4)
          if (pixels[p + 3])
            for (let c = 0; c < 3; c++)
              pixels[p + c] = Math.round((BACKGROUND[c]! + ((1 - BACKGROUND[c]!) * pixels[p + c]!) / 255) * 255);
        // Straight-alpha filtering samples RGB before alpha. Keep the transparent
        // neighbour's colour continuous so a white clipped core has no black rim.
        const beforeBleed = new Uint8Array(pixels);
        for (let y = 0; y < source.image.height; y++)
          for (let x = 0; x < source.image.width; x++) {
            const p = (y * source.image.width + x) * 4;
            if (beforeBleed[p + 3]) continue;
            const rgb = [0, 0, 0];
            let weight = 0;
            for (const [dx, dy] of [
              [-1, 0],
              [1, 0],
              [0, -1],
              [0, 1],
            ]) {
              const nx = x + dx!,
                ny = y + dy!;
              if (nx < 0 || ny < 0 || nx >= source.image.width || ny >= source.image.height) continue;
              const n = (ny * source.image.width + nx) * 4,
                alpha = beforeBleed[n + 3]!;
              weight += alpha;
              for (let c = 0; c < 3; c++) rgb[c]! += beforeBleed[n + c]! * alpha;
            }
            if (weight) for (let c = 0; c < 3; c++) pixels[p + c] = Math.round(rgb[c]! / weight);
          }

        return splitConstantTileColumns(trimTile({ ...source, image: { ...source.image, pixels } })).map((tile) => ({
          tile,
          sprite: register(tile),
        }));
      }),
    );
    const template = data.effects.find((effect) => effect.name === "Our Notes Native Connect W8 P1");
    if (!template) throw new Error("Connect P1 template missing");
    const r = field.rect,
      w = ((r.x1 - r.x0) / 2) * units.x,
      h = ((r.y1 - r.y0) / 2) * units.y;
    const names = connectWallEffectTable();
    for (let level = 0; level < LEVELS; level++) {
      const range = Math.max(
        0,
        ranges.findIndex(({ high }) => levelEnergy(level) <= high),
      );
      const response = ranges[range]!.responses[level]!;
      const particles = carriers[range]!.flatMap((pieces, layer) =>
        pieces.map(({ tile, sprite }) => ({
          sprite,
          color: "#ffffff",
          start: 0,
          duration: 1,
          x: channel(((r.x0 + r.x1) / 2) * units.x + 2 * w * tile.offset[0]),
          y: channel(((r.y0 + r.y1) / 2) * units.y + 2 * h * tile.offset[1]),
          w: channel(w * tile.expand[0]),
          h: channel(h * tile.expand[1]),
          r: channel(0),
          a: channel(layer ? response.coreAlpha : response.bodyAlpha),
        })),
      );
      data.effects.push({
        name: names[`sourceConnectWall${level}`]!,
        transform: template.transform,
        groups: [{ count: 1, particles }],
      });
    }
    const atlas = packAtlas(tiles);
    const packed = repackParticleAtlas(
      { ...data, width: atlas.width, height: atlas.height, sprites: atlas.sprites },
      atlas.png,
      1024,
      {
        denseSearch: true,
        factorConstantTint: true,
        decode: decodeRgba8Png,
        maximumHeight: options.maximumAtlasHeight ?? 1536,
      },
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "particle.data"), gzipSync(JSON.stringify(packed.data), { level: 9 }));
    writeFileSync(resolve(directory, "particle.texture.png"), packed.png);
    reports.push({
      profile,
      sourceDensity,
      nativeDensity: 0.25,
      sourceQuads: quads.length,
      geometry: { rect: field.rect, pixels: [field.width, field.height] },
      carrierTiles: carriers.map((layers) =>
        layers.map((pieces) => pieces.map(({ tile }) => [tile.image.width, tile.image.height])),
      ),
      addedTexels: carriers.reduce(
        (sum, layers) =>
          sum +
          layers.reduce(
            (n, pieces) => n + pieces.reduce((m, { tile }) => m + (tile.image.width + 2) * (tile.image.height + 2), 0),
            0,
          ),
        0,
      ),
      atlas: [packed.data.width, packed.data.height],
      maximumResponseRms: Math.max(
        ...Array.from({ length: LEVELS }, (_, level) => {
          const range = Math.max(
            0,
            ranges.findIndex(({ high }) => levelEnergy(level) <= high),
          );
          return ranges[range]!.responses[level]!.rms;
        }),
      ),
      responses: Array.from({ length: LEVELS }, (_, level) => {
        const range = Math.max(
            0,
            ranges.findIndex(({ high }) => levelEnergy(level) <= high),
          ),
          sample = ranges[range]!.responses[level]!;
        return {
          level,
          energy: levelEnergy(level),
          range,
          bodyAlpha: sample.bodyAlpha,
          coreAlpha: sample.coreAlpha,
          rms: sample.rms,
        };
      }),
    });
    tracer.dispose();
  }
  refreshNativeParticlePackReports(options.destination);
  writeFileSync(
    resolve(options.destination, "connect-wall-aggregate-proof.json"),
    JSON.stringify(
      {
        schema: "our-notes-connect-wall-aggregate-v1",
        sourceSha256: hash(readFileSync(import.meta.filename)),
        levels: LEVELS,
        backgroundRgb8: BACKGROUND.map((v) => Math.round(v * 255)),
        reports,
      },
      null,
      2,
    ) + "\n",
  );
}
