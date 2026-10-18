import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import { NATIVE_PARTICLE_PACKS, NATIVE_PARTICLE_SEMANTIC_PREFIX } from "../../src/shared/particlePacks.ts";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Source = { effects: { name: string; groups: unknown[] }[] };
type Manifest = {
  sourceId: string;
  releaseId: string;
  packs: { key: string; sourcePrefix: string; omittedEmptyEffects: string[] }[];
  sourceEmptyProof?: { file: string; bytes: number; sha256: string };
};

/** Attach independently inspectable pre-split source bytes without rebaking particles. */
export function writeParticleSourceEmptyProof(resourceDir: string, rawFile: string) {
  const manifestFile = resolve(resourceDir, "particle-packs.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Manifest;
  if (!manifest.sourceId || !manifest.releaseId) throw new Error("Missing source/release identity for particle proof");
  const raw = readFileSync(rawFile);
  const json = gunzipSync(raw);
  const source = JSON.parse(json.toString("utf8")) as Source;
  const effects = new Map(source.effects.map((effect) => [effect.name, effect]));
  if (effects.size !== source.effects.length) throw new Error("Duplicate source effects in particle proof");
  for (const pack of NATIVE_PARTICLE_PACKS) {
    const entry = manifest.packs.find(({ key }) => key === pack.key);
    const report = JSON.parse(
      readFileSync(resolve(resourceDir, "particles", pack.key, "particle-pack-report.json"), "utf8"),
    ) as Manifest["packs"][number];
    if (!isDeepStrictEqual(entry, report) || report.sourcePrefix !== pack.prefix)
      throw new Error(`Particle proof report mismatch: ${pack.key}`);
    for (const name of report.omittedEmptyEffects) {
      if (!name.startsWith(`${NATIVE_PARTICLE_SEMANTIC_PREFIX} `)) throw new Error(`Invalid omitted effect: ${name}`);
      const sourceName = pack.prefix + name.slice(NATIVE_PARTICLE_SEMANTIC_PREFIX.length);
      const effect = effects.get(sourceName);
      if (!effect || effect.groups.length !== 0)
        throw new Error(`Omitted effect has no empty source: ${pack.key}: ${name}`);
    }
  }
  const proof = {
    schema: "our-notes-particle-source-empty-v1",
    sourceId: manifest.sourceId,
    releaseId: manifest.releaseId,
    source: {
      file: "source-empty-particle.data",
      bytes: raw.length,
      sha256: sha256(raw),
      jsonSha256: sha256(json),
    },
    profiles: NATIVE_PARTICLE_PACKS.map(({ key, prefix }) => ({
      key,
      sourcePrefix: prefix,
    })),
  };
  const proofBytes = Buffer.from(`${JSON.stringify(proof, null, 2)}\n`);
  writeFileSync(resolve(resourceDir, proof.source.file), raw);
  writeFileSync(resolve(resourceDir, "source-empty-proof.json"), proofBytes);
  manifest.sourceEmptyProof = {
    file: "source-empty-proof.json",
    bytes: proofBytes.length,
    sha256: sha256(proofBytes),
  };
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.sourceEmptyProof;
}
