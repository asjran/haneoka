import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { decodeRgba8Png, encodeRgba8Png } from "./pack-original-note-skins.ts";
import { refreshNativeParticlePackReports } from "./native-particles/packs.ts";
import {
  CONNECT_WALL_DRAW_PROFILES,
  CONNECT_WALL_DRAW_RANGES,
  connectWallDrawCapability,
  connectWallDrawSpriteTable,
} from "../../../.dependencies/sonolus-our-notes/shared/src/engine/data/connectWallDrawContract.ts";

type Rect = { x: number; y: number; w: number; h: number };
type Transform = Record<string, Record<string, number>>;
type Skin = { width: number; height: number; sprites: Array<Rect & { name: string; transform: Transform }> };
type Channel = { from: { c?: number }; to: { c?: number } };
type Part = { sprite: number; color: string; x: Channel; y: Channel; w: Channel; h: Channel; a: Channel };
type Particle = {
  width: number;
  height: number;
  sprites: Rect[];
  effects: Array<{ name: string; groups: Array<{ count: number; particles: Part[] }> }>;
};
type Response = { level: number; energy: number; range: number; bodyAlpha: number; coreAlpha: number };
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const contains = (a: Rect, b: Rect) =>
  a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;
const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function subtract(free: Rect[], used: Rect): Rect[] {
  const result = free.flatMap((r) => {
    if (!intersects(r, used)) return [r];
    const pieces: Rect[] = [];
    if (used.x > r.x) pieces.push({ ...r, w: used.x - r.x });
    if (used.x + used.w < r.x + r.w)
      pieces.push({ ...r, x: used.x + used.w, w: r.x + r.w - used.x - used.w });
    if (used.y > r.y) pieces.push({ ...r, h: used.y - r.y });
    if (used.y + used.h < r.y + r.h)
      pieces.push({ ...r, y: used.y + used.h, h: r.y + r.h - used.y - used.h });
    return pieces;
  });
  return result.filter(
    (r, i) => !result.some((other, j) => j !== i && contains(other, r) && (j < i || !contains(r, other))),
  );
}
function protectedRect(r: Rect, width: number, height: number): Rect {
  const x = Math.max(0, r.x - 2),
    y = Math.max(0, r.y - 2);
  return { x, y, w: Math.min(width, r.x + r.w + 2) - x, h: Math.min(height, r.y + r.h + 2) - y };
}
function transform(part?: Part): Transform {
  const result: Transform = {};
  const x = part?.x.from.c ?? 0,
    y = part?.y.from.c ?? 0,
    w = part?.w.from.c ?? 0,
    h = part?.h.from.c ?? 0;
  for (const [i, px, py] of [
    [1, x - w, y - h],
    [2, x - w, y + h],
    [3, x + w, y + h],
    [4, x + w, y - h],
  ]) {
    const u = (px! + 1) / 2,
      v = (py! + 1) / 2,
      weights = [(1 - u) * (1 - v), (1 - u) * v, u * v, u * (1 - v)];
    for (const axis of ["x", "y"])
      result[`${axis}${i}`] = Object.fromEntries(weights.map((weight, n) => [`${axis}${n + 1}`, weight]));
  }
  return result;
}

/** Append finite Source carriers into existing unoccupied skin texels. */
export function buildConnectWallDrawAssets(options: {
  source: string;
  destination: string;
  generatedFile: string;
  updateGeneratedFile?: boolean;
}) {
  if (resolve(options.source) !== resolve(options.destination))
    cpSync(options.source, options.destination, { recursive: true });
  const proof = JSON.parse(
    readFileSync(resolve(options.source, "connect-wall-aggregate-proof.json"), "utf8"),
  ) as { reports: Array<{ profile: string; responses: Response[] }> };
  const names = connectWallDrawSpriteTable();
  const bank: Array<{
    name: string;
    w: number;
    h: number;
    pixels: Buffer;
    transform: Transform;
    hash: string;
  }> = [];
  const functions: string[] = [];
  const profiles = CONNECT_WALL_DRAW_PROFILES.map((profile, pi) => {
    const directory = resolve(options.destination, "particles", profile);
    const particle = JSON.parse(
      gunzipSync(readFileSync(resolve(directory, "particle.data"))).toString(),
    ) as Particle;
    const image = decodeRgba8Png(readFileSync(resolve(directory, "particle.texture.png")), profile);
    const rows = proof.reports.find((r) => r.profile === profile)!.responses;
    const branches: string[] = [];
    let low = 0;
    for (let range = 0; range < CONNECT_WALL_DRAW_RANGES; range++) {
      const samples = rows.filter((r) => r.range === range && r.energy > 0);
      if (samples.some((r) => r.range > 0 && r.bodyAlpha !== 1))
        throw new Error(`${profile}: variable body response`);
      const representative = particle.effects.find(
        (e) => e.name === `Our Notes Source Connect Wall ${String(samples[0]!.level).padStart(2, "0")}`,
      )!;
      const parts = representative.groups[0]!.particles;
      for (let layer = 0; layer < 2; layer++) {
        // Range-zero body is an availability alias; runtime only draws its core.
        const part = range === 0 ? parts[0] : parts[layer];
        const sprite = part ? particle.sprites[part.sprite]! : { x: 0, y: 0, w: 1, h: 1 };
        const pixels = Buffer.alloc(sprite.w * sprite.h * 4);
        const color = part ? part.color.replace("#", "") : "ffffff";
        for (let y = 0; part && y < sprite.h; y++)
          for (let x = 0; x < sprite.w; x++) {
            const target = (y * sprite.w + x) * 4,
              source = ((sprite.y + y) * image.width + sprite.x + x) * 4;
            for (let c = 0; c < 3; c++)
              pixels[target + c] = Math.round(
                (image.pixels[source + c]! * Number.parseInt(color.slice(c * 2, c * 2 + 2), 16)) / 255,
              );
            pixels[target + 3] = image.pixels[source + 3]!;
          }
        bank.push({
          name: names[`sourceConnectDraw${pi * 18 + range * 2 + layer}`]!,
          w: sprite.w,
          h: sprite.h,
          pixels,
          transform: transform(part),
          hash: hash(pixels),
        });
      }
      const points = [{ energy: low, coreAlpha: 0 }, ...samples];
      const curve: string[] = [];
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!,
          b = points[i]!;
        if (b.energy <= a.energy) continue;
        curve.push(
          `if (energy <= ${b.energy}) return ${a.coreAlpha} + (energy - ${a.energy}) * ${(b.coreAlpha - a.coreAlpha) / (b.energy - a.energy)};`,
        );
      }
      const high = samples.at(-1)!;
      curve.push(`return ${high.coreAlpha};`);
      branches.push(`if (range === ${range}) {\n${curve.join("\n")}\n}`);
      low = high.energy;
    }
    functions.push(`if (profile === ${pi}) {\n${branches.join("\n")}\nreturn 1;\n}`);
    const representative = particle.effects.find((e) => e.name === "Our Notes Source Connect Wall 51")!;
    particle.effects.push({ ...representative, name: connectWallDrawCapability(profile) });
    writeFileSync(resolve(directory, "particle.data"), gzipSync(JSON.stringify(particle), { level: 9 }));
    return {
      profile,
      capability: connectWallDrawCapability(profile),
      capabilityParticles: representative.groups.reduce(
        (sum, group) => sum + group.count * group.particles.length,
        0,
      ),
    };
  });
  mkdirSync(resolve(options.generatedFile, ".."), { recursive: true });
  const high = [0.25, 0.5, 1, 2, 4, 2 ** 2.5, 8, 16];
  const generated = `// Continuous alpha responses fitted to the actual Source carrier bank.\nexport const connectWallDrawRange = (energy: number) => {\n${high.map((v, i) => `if (energy <= ${v}) return ${i};`).join("\n")}\nreturn 8;\n};\nexport const connectWallDrawAlpha = (profile: number, range: number, energy: number) => {\n${functions.join("\n")}\nreturn 0;\n};\n`;
  if (options.updateGeneratedFile) writeFileSync(options.generatedFile, generated);
  else if (readFileSync(options.generatedFile, "utf8") !== generated)
    throw new Error("Connect wall response differs from the compiled engine source");
  const skins = ["skin001", "skin002", "skin003"].map((key) => {
    const dir = resolve(options.destination, "skins", key);
    const skin = JSON.parse(gunzipSync(readFileSync(resolve(dir, "skin.data"))).toString()) as Skin;
    const image = decodeRgba8Png(readFileSync(resolve(dir, "skin.texture.png")), key);
    const original = Buffer.from(image.pixels),
      originals = [...skin.sprites];
    const protectedRects = [
      ...new Map(
        originals.map((r) => {
          const p = protectedRect(r, image.width, image.height);
          return [JSON.stringify(p), p];
        }),
      ).values(),
    ];
    let free: Rect[] = [{ x: 0, y: 0, w: image.width, h: image.height }];
    for (const r of protectedRects) free = subtract(free, r);
    const allocated = new Map<string, Rect>();
    for (const sprite of [...bank].sort((a, b) => b.w * b.h - a.w * a.h)) {
      const id = `${sprite.w}:${sprite.h}:${sprite.hash}`;
      let rect = allocated.get(id);
      if (!rect) {
        const candidates = free
          .filter((r) => r.w >= sprite.w + 4 && r.h >= sprite.h + 4)
          .sort(
            (a, b) =>
              Math.min(a.w - sprite.w - 4, a.h - sprite.h - 4) -
                Math.min(b.w - sprite.w - 4, b.h - sprite.h - 4) || a.w * a.h - b.w * b.h,
          );
        const r = candidates[0];
        if (!r) throw new Error(`${key}: Source draw bank does not fit existing atlas`);
        rect = { x: r.x + 2, y: r.y + 2, w: sprite.w, h: sprite.h };
        allocated.set(id, rect);
        free = subtract(free, { x: r.x, y: r.y, w: sprite.w + 4, h: sprite.h + 4 });
        for (let y = -2; y < sprite.h + 2; y++)
          for (let x = -2; x < sprite.w + 2; x++) {
            const source =
              (Math.max(0, Math.min(sprite.h - 1, y)) * sprite.w + Math.max(0, Math.min(sprite.w - 1, x))) *
              4;
            sprite.pixels.copy(
              image.pixels,
              ((rect.y + y) * image.width + rect.x + x) * 4,
              source,
              source + 4,
            );
          }
      }
      skin.sprites.push({ ...rect, name: sprite.name, transform: sprite.transform });
    }
    for (const r of protectedRects)
      for (let y = r.y; y < r.y + r.h; y++) {
        const start = (y * image.width + r.x) * 4,
          end = start + r.w * 4;
        if (!original.subarray(start, end).equals(image.pixels.subarray(start, end)))
          throw new Error(`${key}: existing sprite/gutter changed`);
      }
    writeFileSync(resolve(dir, "skin.data"), gzipSync(JSON.stringify(skin), { level: 9 }));
    writeFileSync(resolve(dir, "skin.texture.png"), encodeRgba8Png(image));
    return {
      key,
      width: image.width,
      height: image.height,
      originalSprites: originals.length,
      addedSprites: bank.length,
      uniqueTiles: allocated.size,
      addedPaddedTexels: [...allocated.values()].reduce((sum, r) => sum + (r.w + 4) * (r.h + 4), 0),
      originalRgbaTransformAndGuttersUnchanged: true,
    };
  });
  refreshNativeParticlePackReports(options.destination);
  const receipt = {
    schema: "our-notes-connect-wall-draw-v1",
    profiles,
    skins,
    curveSha256: hash(readFileSync(options.generatedFile)),
    sourceSha256: hash(readFileSync(import.meta.filename)),
  };
  writeFileSync(
    resolve(options.destination, "connect-wall-draw-proof.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  return receipt;
}
