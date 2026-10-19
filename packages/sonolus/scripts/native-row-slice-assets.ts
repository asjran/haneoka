// Input: native Simple particle data and RGBA atlas from the cached Source bake.
// Output: compatible same-clock rows merged within the existing atlas budget.
// Pos: late-stage resource producer; direct map: ../L2-2.md.
// Effects: reads particle assets; rewrites compatible Simple rows and pack reports; preserves incompatible rows.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import type { ParticleData } from "./native-particles/merge.ts";
import { decodePng, encodeRgbaPng } from "./native-particles/textureBake.ts";
import { repackParticleAtlas } from "./native-particles/repack.ts";
import { refreshNativeParticlePackReports } from "./native-particles/packs.ts";

type TintParticle = Record<string, unknown> & { sprite: number; color: string };
type SliceChannel = { from?: Record<string, number>; to?: Record<string, number>; ease?: string };
type SliceParticle = TintParticle & {
  start: number;
  duration: number;
  x: SliceChannel;
  y: SliceChannel;
  w: SliceChannel;
  h: SliceChannel;
  r: SliceChannel;
  a: SliceChannel;
};
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Expand only a shared constant middle run; keep the original timeline and two narrow row quads. */
export function buildNativeRowSliceAssets(directory: string) {
  const recipe = {
    baseline: directory,
    output: directory,
    maximumSeamError255: 1,
    profiles: [{ key: "simple", effects: ["Our Notes Native Flick W24 P3", "Our Notes Native Flick Short W24 P3"] }],
  };
  const reports = [];
  for (const profile of recipe.profiles) {
    const directory = resolve(recipe.baseline, "particles", profile.key);
    const originalData = readFileSync(resolve(directory, "particle.data"));
    const originalPng = readFileSync(resolve(directory, "particle.texture.png"));
    const data = JSON.parse(gunzipSync(originalData).toString()) as ParticleData;
    const original = decodePng(originalPng, profile.key);
    const effects = data.effects as Array<{
      name: string;
      groups: Array<{ count: number; particles: SliceParticle[] }>;
    }>;
    const selected = new Set(profile.effects);
    const common = (particle: SliceParticle) =>
      Object.fromEntries(Object.entries(particle).filter(([key]) => key !== "sprite" && key !== "x" && key !== "w"));
    const extra: Array<{ width: number; height: number; pixels: Uint8Array }> = [];
    const registered = new Map<string, number>();
    const records = [];
    const c = (value: number): SliceChannel => ({ from: { c: value }, to: { c: value }, ease: "none" });
    const fixed = (channel: SliceChannel) => {
      const from = channel.from ?? {},
        to = channel.to ?? {};
      return (
        Object.keys(from).every((key) => key === "c") &&
        Object.keys(to).every((key) => key === "c") &&
        (from.c ?? 0) === (to.c ?? 0)
      );
    };
    const column = (id: number, x: number, y: number) => {
      const s = data.sprites[id]!;
      return original.pixels.subarray(
        ((s.y + y) * original.width + s.x + x) * 4,
        ((s.y + y) * original.width + s.x + x + 1) * 4,
      );
    };
    let extraHeight = 0;
    const register = (width: number, height: number, pixels: Uint8Array) => {
      const key = `${width}:${height}:${digest(pixels)}`;
      let id = registered.get(key);
      if (id !== undefined) return id;
      id = data.sprites.length;
      registered.set(key, id);
      data.sprites.push({ x: 0, y: original.height + extraHeight, w: width, h: height });
      extra.push({ width, height, pixels });
      extraHeight += height;
      return id;
    };
    for (const effect of effects) {
      if (!selected.has(effect.name)) continue;
      for (const [groupIndex, group] of effect.groups.entries()) {
        if (group.count !== 1) continue;
        const output: SliceParticle[] = [];
        for (let i = 0; i < group.particles.length; i++) {
          const parts = group.particles.slice(i, i + 3);
          const first = parts[0]!;
          const compatible =
            parts.length === 3 &&
            parts.every(
              (p) =>
                p.start === first.start &&
                p.duration === first.duration &&
                isDeepStrictEqual(common(p), common(first)) &&
                p.color === first.color &&
                JSON.stringify(p.a) === JSON.stringify(first.a) &&
                (["x", "y", "w", "h", "r"] as const).every((key) => fixed(p[key])) &&
                (p.r.from?.c ?? 0) === 0 &&
                p.y.from?.c === first.y.from?.c &&
                p.h.from?.c === first.h.from?.c,
            );
          if (!compatible) {
            output.push(first);
            continue;
          }
          const [left, middle, right] = parts as [SliceParticle, SliceParticle, SliceParticle];
          const [ls, ms, rs] = parts.map((p) => data.sprites[p.sprite]!) as [
            (typeof data.sprites)[number],
            (typeof data.sprites)[number],
            (typeof data.sprites)[number],
          ];
          const lv = left.x.from?.c ?? 0,
            mv = middle.x.from?.c ?? 0,
            rv = right.x.from?.c ?? 0;
          const lw = left.w.from?.c ?? 0,
            mw = middle.w.from?.c ?? 0,
            rw = right.w.from?.c ?? 0;
          const dx = (2 * lw) / ls.w,
            columns = Math.round((2 * mw) / dx);
          if (!(
            lw > 0 &&
            mw > 0 &&
            rw > 0 &&
            ms.w === 1 &&
            ls.h === ms.h &&
            ms.h === rs.h &&
            Math.abs(lv + lw - (mv - mw)) < 1e-10 &&
            Math.abs(mv + mw - (rv - rw)) < 1e-10 &&
            Math.abs((2 * rw) / rs.w - dx) < 1e-12 &&
            Math.abs((2 * mw) / dx - columns) < 1e-8
          )) {
            output.push(first);
            continue;
          }
          let seamError = 0;
          for (let y = 0; y < ls.h; y++) {
            const centre = column(middle.sprite, 0, y);
            for (const edge of [column(left.sprite, ls.w - 1, y), column(right.sprite, 0, y)])
              for (let step = 0; step <= 64; step++) {
                const t = step / 64;
                const old = t < 0.5 ? edge : centre;
                const mixed = Array.from(centre, (value, channel) => edge[channel]! + (value - edge[channel]!) * t);
                for (let channel = 0; channel < 3; channel++)
                  for (const background of [0, 255]) {
                    const a = old[3]! / 255,
                      b = mixed[3]! / 255;
                    seamError = Math.max(
                      seamError,
                      Math.abs(old[channel]! * a + background * (1 - a) - mixed[channel]! * b - background * (1 - b)),
                    );
                  }
              }
          }
          const total = ls.w + columns + rs.w,
            split = Math.floor(total / 2);
          const record = {
            effect: effect.name,
            group: groupIndex,
            index: i,
            sprites: parts.map((p) => p.sprite),
            start: first.start,
            duration: first.duration,
            rowHeight: ls.h,
            fullColumns: total,
            seamError255: seamError,
            accepted: seamError <= recipe.maximumSeamError255 && Math.max(split, total - split) + 2 <= original.width,
          };
          records.push(record);
          if (!record.accepted) {
            output.push(first);
            continue;
          }
          for (const [x0, x1] of [
            [0, split],
            [split, total],
          ]) {
            const width = x1! - x0!,
              pixels = new Uint8Array(width * ls.h * 4);
            for (let y = 0; y < ls.h; y++)
              for (let x = x0!; x < x1!; x++) {
                const source =
                  x < ls.w
                    ? column(left.sprite, x, y)
                    : x < ls.w + columns
                      ? column(middle.sprite, 0, y)
                      : column(right.sprite, x - ls.w - columns, y);
                pixels.set(source, (y * width + x - x0!) * 4);
              }
            output.push({
              ...first,
              sprite: register(width, ls.h, pixels),
              x: c(lv - lw + ((x0! + x1!) / 2) * dx),
              w: c((width * dx) / 2),
            });
          }
          i += 2;
        }
        group.particles = output;
      }
    }
    if (!records.some((record) => record.accepted)) {
      reports.push({ profile: profile.key, mergedTriples: 0, reason: "no-compatible-rows" });
      continue;
    }
    const height = original.height + extraHeight,
      pixels = new Uint8Array(original.width * height * 4);
    pixels.set(original.pixels);
    let row = original.height;
    for (const tile of extra) {
      for (let y = 0; y < tile.height; y++)
        pixels.set(tile.pixels.subarray(y * tile.width * 4, (y + 1) * tile.width * 4), (row + y) * original.width * 4);
      row += tile.height;
    }
    let packed: ReturnType<typeof repackParticleAtlas>;
    try {
      packed = repackParticleAtlas(
        { ...data, height },
        encodeRgbaPng({ width: original.width, height, pixels }),
        original.width,
        { maximumHeight: original.height, denseSearch: true },
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Referenced particle tiles do not fit")) throw error;
      reports.push({ profile: profile.key, mergedTriples: 0, reason: "atlas-capacity" });
      continue;
    }
    if (packed.data.width * packed.data.height > original.width * original.height)
      throw Error("Native slice atlas grew: " + profile.key);
    const out = resolve(recipe.output, "particles", profile.key);
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "particle.data"), gzipSync(JSON.stringify(packed.data), { level: 9 }));
    writeFileSync(resolve(out, "particle.texture.png"), packed.png);
    reports.push({
      profile: profile.key,
      sourceDataSha256: digest(originalData),
      sourceTextureSha256: digest(originalPng),
      dimensionsBefore: [original.width, original.height],
      dimensionsAfter: [packed.data.width, packed.data.height],
      addedUniqueTiles: extra.length,
      mergedTriples: records.filter((r) => r.accepted).length,
      records,
    });
  }
  if (reports.some((report) => report.mergedTriples > 0)) refreshNativeParticlePackReports(recipe.output);
  writeFileSync(
    resolve(recipe.output, "native-row-slice-proof.json"),
    JSON.stringify(
      {
        sourceSha256: digest(readFileSync(import.meta.filename)),
        maximumSeamError255: recipe.maximumSeamError255,
        method:
          "Same-clock static horizontal triples become two contiguous half-row sprites; no alpha/phase fitting. Original colours and repeated middle texels retained.",
        reports,
      },
      null,
      2,
    ) + "\n",
  );
  return { mergedTriples: reports.reduce((sum, report) => sum + report.mergedTriples, 0), reports };
}
