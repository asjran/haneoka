import { createHash } from "node:crypto";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { decodeRgba8Png, encodeRgba8Png } from "./pack-original-note-skins.ts";
import { packRectangles } from "./native-particles/rectanglePacking.ts";
import { encodeRgbaPng } from "./native-particles/textureBake.ts";
import { refreshNativeParticlePackReports } from "./native-particles/packs.ts";
import {
  CONNECT_WALL_DRAW_PROFILES,
  connectFrameDrawCapability,
  connectFrameDrawSpriteTable,
} from "../../../.dependencies/sonolus-our-notes/shared/src/engine/data/connectWallDrawContract.ts";
type Rect = { x: number; y: number; w: number; h: number };
type Transform = Record<string, Record<string, number>>;
type Skin = {
  width: number;
  height: number;
  sprites: Array<Rect & { name: string; transform: Transform }>;
};
type Channel = { from: { c?: number }; to: { c?: number } };
type Part = {
  sprite: number;
  color: string;
  x: Channel;
  y: Channel;
  w: Channel;
  h: Channel;
  a: Channel;
};
type Particle = {
  width: number;
  height: number;
  sprites: Rect[];
  effects: Array<{
    name: string;
    groups: Array<{ count: number; particles: Part[] }>;
  }>;
};
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
    (r, i) =>
      !result.some(
        (other, j) =>
          j !== i && contains(other, r) && (j < i || !contains(r, other)),
      ),
  );
}
function protectedRect(r: Rect, width: number, height: number): Rect {
  const x = Math.max(0, r.x - 2),
    y = Math.max(0, r.y - 2);
  return {
    x,
    y,
    w: Math.min(width, r.x + r.w + 2) - x,
    h: Math.min(height, r.y + r.h + 2) - y,
  };
}

type Carrier = {
  name: string;
  w: number;
  h: number;
  pixels: Buffer;
  transform: Transform;
  hash: string;
};
type Snapshot = {
  runtimeHashes: Record<string, string>;
  formalInputs: Array<{ path: string; sha256: string }>;
  schema: string;
  curveSha256: string;
  contractSha256: string;
  textureSha256: string;
  width: number;
  height: number;
  geometry: unknown[];
  sprites: Array<
    Rect & { name: string; transform: Transform; rgbaSha256: string }
  >;
};
/** Append the verified formal-source bank without tracing or fitting during a normal resource build. */
export function buildConnectFrameDrawAssets(options: {
  source: string;
  destination: string;
  generatedFile: string;
  bankDirectory?: string;
  releaseRoot: string;
  packing?: number;
}) {
  const directory =
      options.bankDirectory ??
      resolve(
        import.meta.dirname,
        "../assets/native-particles/source-connect-frame-v1",
      ),
    manifest = JSON.parse(
      readFileSync(resolve(directory, "manifest.json"), "utf8"),
    ) as Snapshot;
  if (manifest.schema !== "our-notes-source-connect-frame-v1")
    throw Error("Unknown Connect frame carrier snapshot");
  if (hash(readFileSync(options.generatedFile)) !== manifest.curveSha256)
    throw Error("Connect frame response differs from the compiled engine");
  const contract = resolve(
    import.meta.dirname,
    "../../../.dependencies/sonolus-our-notes/shared/src/engine/data/connectWallDrawContract.ts",
  );
  if (hash(readFileSync(contract)) !== manifest.contractSha256)
    throw Error("Connect frame geometry differs from the compiled contract");
  const png = readFileSync(resolve(directory, "carriers.png"));
  if (hash(png) !== manifest.textureSha256)
    throw Error("Connect frame carrier texture changed");
  const recipe = JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../assets/native-particles/production.v1.json",
      ),
      "utf8",
    ),
  ) as { runtimeHashes: Record<string, string> };
  for (const [name, expected] of Object.entries(manifest.runtimeHashes))
    if (recipe.runtimeHashes[name] !== expected)
      throw Error("Connect frame source runtime changed: " + name);
  for (const input of manifest.formalInputs)
    if (
      hash(readFileSync(resolve(options.releaseRoot, input.path))) !==
      input.sha256
    )
      throw Error("Connect frame formal input changed: " + input.path);
  const image = decodeRgba8Png(png, "Connect frame bank");
  if (image.width !== manifest.width || image.height !== manifest.height)
    throw Error("Connect frame bank dimensions changed");
  const expected = Object.values(connectFrameDrawSpriteTable());
  if (
    manifest.sprites.length !== expected.length ||
    manifest.sprites.some((sprite, i) => sprite.name !== expected[i])
  )
    throw Error("Connect frame bank does not match engine sprite order");
  const bank: Carrier[] = manifest.sprites.map((r) => {
    const pixels = Buffer.alloc(r.w * r.h * 4);
    for (let y = 0; y < r.h; y++)
      image.pixels.copy(
        pixels,
        y * r.w * 4,
        ((r.y + y) * image.width + r.x) * 4,
        ((r.y + y) * image.width + r.x + r.w) * 4,
      );
    if (hash(pixels) !== r.rgbaSha256)
      throw Error("Connect frame carrier changed: " + r.name);
    return {
      name: r.name,
      w: r.w,
      h: r.h,
      pixels,
      transform: r.transform,
      hash: r.rgbaSha256,
    };
  });
  const geometryReports = manifest.geometry;
  if (resolve(options.source) !== resolve(options.destination))
    cpSync(options.source, options.destination, { recursive: true });
  const skins = ["skin001", "skin002", "skin003"].map((key) => {
    const dir = resolve(options.destination, "skins", key),
      skin = JSON.parse(
        gunzipSync(readFileSync(resolve(dir, "skin.data"))).toString(),
      ) as Skin;
    const image = decodeRgba8Png(
      readFileSync(resolve(dir, "skin.texture.png")),
      key,
    );
    if (key === "skin002") {
      let failure: unknown;
      for (const mode of [
        {},
        { rotateNew: true },
        { wide: true },
        { wide: true, rotateNew: true },
      ]) {
        const data = JSON.parse(
            gunzipSync(readFileSync(resolve(dir, "skin.data"))).toString(),
          ) as Skin,
          png = decodeRgba8Png(
            readFileSync(resolve(dir, "skin.texture.png")),
            key,
          );
        try {
          const receipt = repackSkinWithFrameBank(data, png, bank, mode);
          writeFileSync(
            resolve(dir, "skin.data"),
            gzipSync(JSON.stringify(data), { level: 9 }),
          );
          writeFileSync(resolve(dir, "skin.texture.png"), encodeRgbaPng(png));
          writeFileSync(
            resolve(dir, "frame-repack-proof.json"),
            JSON.stringify(receipt, null, 2) + "\n",
          );
          return { key, ...receipt, spriteProof: undefined };
        } catch (error) {
          failure = error;
          console.log(
            "frame-repack-attempt",
            JSON.stringify(mode),
            String(error),
          );
        }
      }
      throw failure;
    }
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
    const allocated = new Map<string, Rect & { rotated?: boolean }>();
    const strategy = options.packing ?? 0;
    for (const sprite of [...bank].sort((a, b) =>
      strategy === 1
        ? Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h
        : strategy === 2
          ? Math.min(b.w, b.h) - Math.min(a.w, a.h) || b.w * b.h - a.w * a.h
          : b.w * b.h - a.w * a.h,
    )) {
      const id = `${sprite.w}:${sprite.h}:${sprite.hash}`;
      let rect = allocated.get(id);
      if (!rect) {
        const candidates = free
          .flatMap((r) =>
            [false, true]
              .filter(
                (rotated) =>
                  r.w >= (rotated ? sprite.h : sprite.w) + 4 &&
                  r.h >= (rotated ? sprite.w : sprite.h) + 4,
              )
              .map((rotated) => ({
                r,
                rotated,
                w: rotated ? sprite.h : sprite.w,
                h: rotated ? sprite.w : sprite.h,
              })),
          )
          .sort((a, b) =>
            strategy === 1
              ? a.r.w * a.r.h - b.r.w * b.r.h
              : strategy === 2
                ? Math.max(a.r.w - a.w - 4, a.r.h - a.h - 4) -
                    Math.max(b.r.w - b.w - 4, b.r.h - b.h - 4) ||
                  a.r.w * a.r.h - b.r.w * b.r.h
                : Math.min(a.r.w - a.w - 4, a.r.h - a.h - 4) -
                    Math.min(b.r.w - b.w - 4, b.r.h - b.h - 4) ||
                  a.r.w * a.r.h - b.r.w * b.r.h,
          );
        const candidate = candidates[0],
          r = candidate?.r;
        if (!r)
          throw Error(
            key +
              ": frame bank does not fit original atlas " +
              JSON.stringify({
                sprite: [sprite.name, sprite.w, sprite.h],
                allocated: allocated.size,
                free: free.sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 10),
              }),
          );
        rect = {
          x: r.x + 2,
          y: r.y + 2,
          w: candidate!.w,
          h: candidate!.h,
          rotated: candidate!.rotated,
        };
        allocated.set(id, rect);
        free = subtract(free, { x: r.x, y: r.y, w: rect.w + 4, h: rect.h + 4 });
        for (let y = -2; y < rect.h + 2; y++)
          for (let x = -2; x < rect.w + 2; x++) {
            const rx = Math.max(0, Math.min(rect.w - 1, x)),
              ry = Math.max(0, Math.min(rect.h - 1, y)),
              sx = rect.rotated ? ry : rx,
              sy = rect.rotated ? sprite.h - 1 - rx : ry;
            const source = (sy * sprite.w + sx) * 4;
            sprite.pixels.copy(
              image.pixels,
              ((rect.y + y) * image.width + rect.x + x) * 4,
              source,
              source + 4,
            );
          }
      }
      const { rotated, ...bounds } = rect;
      const mapping = [4, 1, 2, 3],
        tr = rotated
          ? Object.fromEntries(
              [1, 2, 3, 4].flatMap((i) =>
                ["x", "y"].map((axis) => [
                  axis + i,
                  sprite.transform[axis + mapping[i - 1]!]!,
                ]),
              ),
            )
          : sprite.transform;
      skin.sprites.push({ ...bounds, name: sprite.name, transform: tr });
    }
    for (const r of protectedRects)
      for (let y = r.y; y < r.y + r.h; y++) {
        const start = (y * image.width + r.x) * 4,
          end = start + r.w * 4;
        if (
          !original
            .subarray(start, end)
            .equals(image.pixels.subarray(start, end))
        )
          throw Error(key + ": existing sprite/gutter changed");
      }
    if (
      JSON.stringify(skin.sprites.slice(0, originals.length)) !==
      JSON.stringify(originals)
    )
      throw Error(key + ": existing sprite transform changed");
    writeFileSync(
      resolve(dir, "skin.data"),
      gzipSync(JSON.stringify(skin), { level: 9 }),
    );
    writeFileSync(resolve(dir, "skin.texture.png"), encodeRgba8Png(image));
    return {
      key,
      width: image.width,
      height: image.height,
      originalSprites: originals.length,
      addedSprites: bank.length,
      uniqueTiles: allocated.size,
      addedPaddedTexels: [...allocated.values()].reduce(
        (n, r) => n + (r.w + 4) * (r.h + 4),
        0,
      ),
      originalRgbaTransformAndGuttersUnchanged: true,
    };
  });
  const profiles = CONNECT_WALL_DRAW_PROFILES.map((profile) => {
    const dir = resolve(options.destination, "particles", profile),
      file = resolve(dir, "particle.data"),
      data = JSON.parse(gunzipSync(readFileSync(file)).toString()) as Particle;
    const template = data.effects.find(
      (e) => e.name === "Our Notes Native Connect W8 P3",
    );
    if (!template)
      throw Error(profile + ": formal Connect P3 capability template missing");
    const capability = connectFrameDrawCapability(profile);
    if (data.effects.some((e) => e.name === capability))
      throw Error("Duplicate frame capability");
    data.effects.push({ ...template, name: capability });
    writeFileSync(file, gzipSync(JSON.stringify(data), { level: 9 }));
    return {
      profile,
      capability,
      originalEffects: data.effects.length - 1,
      appendedEffects: 1,
    };
  });
  refreshNativeParticlePackReports(options.destination);
  const proof = {
    schema: "our-notes-connect-frame-draw-v1",
    geometry: geometryReports,
    profiles,
    skins,
    sourceSha256: hash(readFileSync(import.meta.filename)),
    curveSha256: hash(readFileSync(options.generatedFile)),
  };
  writeFileSync(
    resolve(options.destination, "connect-frame-draw-proof.json"),
    JSON.stringify(proof, null, 2) + "\n",
  );
  return proof;
}

/** Move intersecting Source texture components together and retain every legacy filtering texel. */
function repackSkinWithFrameBank(
  skin: Skin,
  image: ReturnType<typeof decodeRgba8Png>,
  bank: Array<{
    name: string;
    w: number;
    h: number;
    pixels: Buffer;
    transform: Transform;
    hash: string;
  }>,
  mode: { rotateNew?: boolean; wide?: boolean } = {},
) {
  if (mode.rotateNew)
    bank = bank.map((b) => {
      if (b.h <= b.w) return b;
      const pixels = Buffer.alloc(b.pixels.length);
      for (let y = 0; y < b.h; y++)
        for (let x = 0; x < b.w; x++)
          b.pixels.copy(
            pixels,
            (x * b.h + b.h - 1 - y) * 4,
            (y * b.w + x) * 4,
            (y * b.w + x) * 4 + 4,
          );
      const map = [4, 1, 2, 3],
        transform = Object.fromEntries(
          [1, 2, 3, 4].flatMap((i) =>
            ["x", "y"].map((axis) => [
              axis + i,
              b.transform[axis + map[i - 1]!]!,
            ]),
          ),
        );
      return { ...b, w: b.h, h: b.w, pixels, transform, hash: hash(pixels) };
    });
  const originalWidth = image.width,
    originalHeight = image.height;
  const originalSprites = skin.sprites.map((s) => ({ ...s })),
    original = Buffer.from(image.pixels),
    parents = skin.sprites.map((_, i) => i);
  const root = (i: number): number =>
    parents[i] === i ? i : (parents[i] = root(parents[i]!));
  for (let i = 0; i < skin.sprites.length; i++)
    for (let j = 0; j < i; j++)
      if (intersects(skin.sprites[i]!, skin.sprites[j]!))
        parents[root(i)] = root(j);
  const groups = new Map<number, { bounds: Rect; indices: number[] }>();
  for (const [i, r] of skin.sprites.entries()) {
    const k = root(i),
      p = protectedRect(r, image.width, image.height),
      old = groups.get(k);
    if (old) {
      const x = Math.min(old.bounds.x, p.x),
        y = Math.min(old.bounds.y, p.y);
      old.bounds = {
        x,
        y,
        w: Math.max(old.bounds.x + old.bounds.w, p.x + p.w) - x,
        h: Math.max(old.bounds.y + old.bounds.h, p.y + p.h) - y,
      };
      old.indices.push(i);
    } else groups.set(k, { bounds: p, indices: [i] });
  }
  const allComponents = [...groups.values()],
    componentIds = new Map<string, number>(),
    components: typeof allComponents = [];
  for (const c of allComponents) {
    const r = c.bounds,
      pixels = Buffer.alloc(r.w * r.h * 4);
    for (let y = 0; y < r.h; y++)
      original.copy(
        pixels,
        y * r.w * 4,
        ((r.y + y) * image.width + r.x) * 4,
        ((r.y + y) * image.width + r.x + r.w) * 4,
      );
    const key = r.w + ":" + r.h + ":" + hash(pixels);
    let id = componentIds.get(key);
    if (id === undefined) {
      id = components.length;
      componentIds.set(key, id);
      components.push(c);
    } else {
      const target = components[id]!;
      for (const i of c.indices) {
        const sprite = skin.sprites[i]!;
        sprite.x += target.bounds.x - r.x;
        sprite.y += target.bounds.y - r.y;
        target.indices.push(i);
      }
    }
  }
  const distinct = [
    ...new Map(bank.map((b) => [`${b.w}:${b.h}:${b.hash}`, b])).values(),
  ];
  const aliases = new Map<string, { parent: string; x: number; y: number }>(),
    unique: typeof distinct = [];
  const pad = (b: (typeof bank)[number]) => {
    const w = b.w + 4,
      h = b.h + 4,
      pixels = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i =
          (Math.max(0, Math.min(b.h - 1, y - 2)) * b.w +
            Math.max(0, Math.min(b.w - 1, x - 2))) *
          4;
        b.pixels.copy(pixels, (y * w + x) * 4, i, i + 4);
      }
    return { w, h, pixels };
  };
  const padded = new Map<string, ReturnType<typeof pad>>();
  for (const b of [...distinct].sort((a, b) => b.w * b.h - a.w * a.h)) {
    const key = `${b.w}:${b.h}:${b.hash}`,
      small = pad(b);
    let found = false;
    for (const p of unique) {
      const parent = `${p.w}:${p.h}:${p.hash}`,
        big = padded.get(parent)!;
      if (big.w < small.w || big.h < small.h) continue;
      const row = small.pixels.subarray(0, small.w * 4);
      let start = 0;
      while (start < big.pixels.length) {
        const index = big.pixels.indexOf(row, start);
        if (index < 0) break;
        start = index + 4;
        if (index % 4) continue;
        const y = Math.floor(index / (big.w * 4)),
          x = index / 4 - y * big.w;
        if (x + small.w > big.w || y + small.h > big.h) continue;
        let match = true;
        for (let dy = 1; dy < small.h; dy++)
          if (
            !small.pixels
              .subarray(dy * small.w * 4, (dy + 1) * small.w * 4)
              .equals(
                big.pixels.subarray(
                  ((y + dy) * big.w + x) * 4,
                  ((y + dy) * big.w + x + small.w) * 4,
                ),
              )
          ) {
            match = false;
            break;
          }
        if (match) {
          aliases.set(key, { parent, x, y });
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) {
      unique.push(b);
      padded.set(key, small);
    }
  }
  const rects = [
    ...components.map((c) => ({ width: c.bounds.w, height: c.bounds.h })),
    ...unique.map((b) => ({ width: b.w + 4, height: b.h + 4 })),
  ];
  const targetWidth = mode.wide ? 4096 : image.width,
    targetHeight = mode.wide ? 2048 : image.height,
    placements = packRectangles(rects, targetWidth, true, targetHeight);
  if (!placements)
    throw Error(
      "Lossless component repack does not fit " +
        JSON.stringify({
          components: components.length,
          unique: unique.length,
          area: rects.reduce((n, r) => n + r.width * r.height, 0),
          capacity: image.width * image.height,
        }),
    );
  image.width = targetWidth;
  image.height = targetHeight;
  skin.width = targetWidth;
  skin.height = targetHeight;
  image.pixels.fill(0);
  for (const [i, c] of components.entries()) {
    const at = placements[i]!,
      r = c.bounds;
    for (let y = 0; y < r.h; y++)
      original.copy(
        image.pixels,
        ((at.y + y) * image.width + at.x) * 4,
        ((r.y + y) * originalWidth + r.x) * 4,
        ((r.y + y) * originalWidth + r.x + r.w) * 4,
      );
    for (const id of c.indices) {
      const s = skin.sprites[id]!;
      s.x += at.x - r.x;
      s.y += at.y - r.y;
    }
  }
  const allocations = new Map<string, Rect>();
  for (const [i, b] of unique.entries()) {
    const at = placements[components.length + i]!,
      r = { x: at.x + 2, y: at.y + 2, w: b.w, h: b.h };
    allocations.set(`${b.w}:${b.h}:${b.hash}`, r);
    for (let y = -2; y < b.h + 2; y++)
      for (let x = -2; x < b.w + 2; x++) {
        const from =
          (Math.max(0, Math.min(b.h - 1, y)) * b.w +
            Math.max(0, Math.min(b.w - 1, x))) *
          4;
        b.pixels.copy(
          image.pixels,
          ((r.y + y) * image.width + r.x + x) * 4,
          from,
          from + 4,
        );
      }
  }
  for (const [key, a] of aliases) {
    const parent = allocations.get(a.parent)!;
    const b = distinct.find((b) => `${b.w}:${b.h}:${b.hash}` === key)!;
    allocations.set(key, {
      x: parent.x + a.x,
      y: parent.y + a.y,
      w: b.w,
      h: b.h,
    });
  }
  const spriteProof = originalSprites.map((before, i) => {
    const after = skin.sprites[i]!,
      r = protectedRect(before, originalWidth, originalHeight),
      a = Buffer.alloc(r.w * r.h * 4),
      b = Buffer.alloc(a.length);
    for (let y = 0; y < r.h; y++) {
      original.copy(
        a,
        y * r.w * 4,
        ((r.y + y) * originalWidth + r.x) * 4,
        ((r.y + y) * originalWidth + r.x + r.w) * 4,
      );
      const x = after.x + (r.x - before.x),
        ny = after.y + (r.y - before.y) + y;
      image.pixels.copy(
        b,
        y * r.w * 4,
        (ny * image.width + x) * 4,
        (ny * image.width + x + r.w) * 4,
      );
    }
    const { x: _bx, y: _by, ...oldMetadata } = before,
      { x: _ax, y: _ay, ...newMetadata } = after;
    if (
      !a.equals(b) ||
      JSON.stringify(oldMetadata) !== JSON.stringify(newMetadata)
    )
      throw Error("Legacy sprite/gutter/transform changed: " + before.name);
    return {
      name: before.name,
      before: [before.x, before.y],
      after: [after.x, after.y],
      rgbaAndGutterSha256: hash(a),
      metadataSha256: hash(Buffer.from(JSON.stringify(oldMetadata))),
    };
  });
  for (const b of bank)
    skin.sprites.push({
      ...allocations.get(`${b.w}:${b.h}:${b.hash}`)!,
      name: b.name,
      transform: b.transform,
    });
  return {
    width: image.width,
    height: image.height,
    originalSprites: originalSprites.length,
    addedSprites: bank.length,
    uniqueTiles: unique.length,
    losslessNestedCarrierTiles: aliases.size,
    legacyComponents: components.length,
    legacySpriteOrderPixelsDimensionsTransformAndGuttersUnchanged: true,
    spriteProof,
  };
}
