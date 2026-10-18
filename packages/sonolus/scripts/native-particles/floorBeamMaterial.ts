import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { decodeRgba8Png } from "../pack-original-note-skins.ts";
import { encodeRgbaPng } from "./textureBake.ts";
import { refreshNativeParticlePackReports } from "./packs.ts";
import type { ParticleData } from "./merge.ts";
import { prepareBeamTransfer, type Rgb, type TintWeight } from "./floorBeamTransfer.ts";
import { ease, type EaseName } from "./fit.ts";
import type { TrajectoryParticle } from "./trajectory.ts";

type Particle = Record<string, unknown> & Pick<TrajectoryParticle, "sprite" | "color" | "a" | "duration">;
type Group = { count: number; particles: Particle[] };
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const STAGE_BACKGROUND: Rgb = [10 / 255, 22 / 255, 49 / 255];
const EXPOSURE_SAMPLES = [
  [0.046910077030668, 0.118463442528095],
  [0.230765344947158, 0.239314335249683],
  [0.5, 0.284444444444444],
  [0.769234655052842, 0.239314335249683],
  [0.953089922969332, 0.118463442528095],
] as const;
const colour = (hex: string): Rgb => {
  const rgb = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1);
  return [0, 2, 4].map((offset) => Number.parseInt(rgb.slice(offset, offset + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
};

/** Encode Source's additive walls over the stage while retaining their authored bright core. */
export function buildFloorBeamMaterialAssets(directory: string, background: Rgb = STAGE_BACKGROUND) {
  const capture = process.env.SONOLUS_CAPTURE_PRE_MATERIAL_DIRECTORY;
  if (capture) {
    const files = [
      "particle-packs.json",
      ...["standard", "light", "simple"].flatMap((profile) =>
        ["particle.data", "particle.texture.png", "particle-pack-report.json"].map(
          (file) => `particles/${profile}/${file}`,
        ),
      ),
    ];
    const copied = files.map((file) => {
      const destination = resolve(capture, file);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(resolve(directory, file), destination);
      return { file, sha256: digest(readFileSync(destination)) };
    });
    writeFileSync(resolve(capture, "pre-material-capture.json"), JSON.stringify({ files: copied }, null, 2) + "\n");
  }
  const reports = [];
  for (const profile of ["standard", "light", "simple"]) {
    const root = resolve(directory, "particles", profile);
    const inputData = readFileSync(resolve(root, "particle.data"));
    const inputTexture = readFileSync(resolve(root, "particle.texture.png"));
    const data = JSON.parse(gunzipSync(inputData).toString()) as ParticleData;
    const image = decodeRgba8Png(inputTexture, "floor and beam material input");
    const colours = new Map<number, Map<string, TintWeight>>();
    let changedDefinitions = 0,
      beforeOpacity = 0,
      afterOpacity = 0,
      highBefore = 0,
      highAfter = 0,
      sourceOverError = 0,
      compensatedError = 0,
      materialPixels = 0;
    for (const effect of data.effects) {
      const match = /^Our Notes Native .+ W\d+ (P1|P2|B0)$/.exec(String(effect.name));
      const centerBeams = profile !== "simple" && /^Our Notes Native Flick W\d+ P0$/.test(String(effect.name));
      if (!match && !centerBeams) continue;
      for (const [groupIndex, group] of (effect.groups as Group[]).entries()) {
        if (centerBeams && groupIndex !== 1 && groupIndex !== 2) continue;
        if (match?.[1] === "B0" && groupIndex >= 2) continue;
        for (const particle of group.particles) {
          let uses = colours.get(particle.sprite);
          if (!uses) colours.set(particle.sprite, (uses = new Map()));
          for (const [q, weight] of EXPOSURE_SAMPLES) {
            const from = particle.a.from.c ?? 0;
            const alpha = Math.max(
              0,
              Math.min(1, from + ((particle.a.to.c ?? 0) - from) * ease((particle.a.ease ?? "linear") as EaseName, q)),
            );
            if (alpha === 0) continue;
            const key = `${particle.color}|${alpha.toPrecision(12)}`;
            const existing = uses.get(key);
            if (existing) existing.weight += particle.duration * weight;
            else
              uses.set(key, {
                rgb: colour(particle.color),
                alpha,
                weight: particle.duration * weight,
              });
          }
          changedDefinitions++;
        }
      }
    }
    const pixels = new Uint8Array(image.pixels);
    for (const [index, uses] of colours) {
      const sprite = data.sprites[index]!;
      const transfer = prepareBeamTransfer([...uses.values()], background);
      for (let y = -1; y <= sprite.h; y++)
        for (let x = -1; x <= sprite.w; x++) {
          const i = ((sprite.y + y) * image.width + sprite.x + x) * 4;
          const alpha = image.pixels[i + 3]! / 255;
          if (alpha === 0) continue;
          const result = transfer([image.pixels[i]!, image.pixels[i + 1]!, image.pixels[i + 2]!, image.pixels[i + 3]!]);
          pixels.set(result.rgba, i);
          if (x < 0 || y < 0 || x >= sprite.w || y >= sprite.h) continue;
          sourceOverError += result.sourceOverError;
          compensatedError += result.compensatedError;
          materialPixels++;
          beforeOpacity += alpha;
          afterOpacity += pixels[i + 3]! / 255;
          if (alpha >= 0.75) highBefore++;
          if (pixels[i + 3]! >= 0.75 * 255) highAfter++;
        }
    }
    const packed = {
      data,
      png: encodeRgbaPng({ width: image.width, height: image.height, pixels }),
    };
    const outputData = inputData;
    writeFileSync(resolve(root, "particle.data"), outputData);
    writeFileSync(resolve(root, "particle.texture.png"), packed.png);
    const count = (value: ParticleData) => ({
      effects: value.effects.length,
      groups: value.effects.reduce((n, effect) => n + (effect.groups as Group[]).length, 0),
      definitions: value.effects.reduce(
        (n, effect) => n + (effect.groups as Group[]).reduce((m, group) => m + group.particles.length, 0),
        0,
      ),
    });
    reports.push({
      profile,
      input: { data: digest(inputData), texture: digest(inputTexture) },
      output: { data: digest(outputData), texture: digest(packed.png) },
      changedDefinitions,
      before: count(data),
      after: count(packed.data),
      atlas: [packed.data.width, packed.data.height],
      materialTexels: { beforeOpacity, afterOpacity, highBefore, highAfter },
      additiveComposition: {
        backgroundRgb8: background.map((value) => Math.round(value * 255)),
        sourceOverRms: Math.sqrt(sourceOverError / Math.max(1, materialPixels * 3)),
        compensatedRms: Math.sqrt(compensatedError / Math.max(1, materialPixels * 3)),
        finalTintIncluded: true,
        target: "clamp(background + sourceEmission * tint * phaseAlpha, 0, 1)",
        exposureWeight: "duration with five-point Gaussian quadrature of the actual alpha easing",
        dynamicTintColoursPreserved: true,
        whitenedTexels: 0,
      },
      addedQuads: 0,
      addedGroups: 0,
      expandedGeometry: false,
    });
  }
  refreshNativeParticlePackReports(directory);
  writeFileSync(
    resolve(directory, "floor-beam-material-proof.json"),
    JSON.stringify(
      {
        schema: "our-notes-floor-beam-material-v1",
        sourceSha256: digest(readFileSync(import.meta.filename)),
        transferSourceSha256: digest(readFileSync(resolve(import.meta.dirname, "floorBeamTransfer.ts"))),
        transfer: {
          frame: { transfer: "unchanged-formal-source-near-bloom" },
          beam: {
            transfer: "minimum-error-additive-stage-compensation",
            backgroundRgb8: background.map((value) => Math.round(value * 255)),
          },
          brightCore: "authored-source-carriers",
        },
        reports,
      },
      null,
      2,
    ) + "\n",
  );
}
