import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type File = { path: string; bytes: number; sha256: string };
function files(directory: string): File[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory()
        ? files(path).map((file) => ({ ...file, path: `${entry.name}/${file.path}` }))
        : entry.isFile()
          ? [{ path: entry.name, bytes: readFileSync(path).length, sha256: hash(readFileSync(path)) }]
          : [];
    });
}
export function particleCacheKey(input: unknown) {
  return hash(Buffer.from(JSON.stringify(input)));
}
export function restoreParticleCache(root: string, key: string, destination: string): boolean {
  const directory = resolve(root, ".cache/sonolus-native-particles", key);
  const receipt = resolve(directory, "cache.json");
  if (!existsSync(receipt)) return false;
  const manifest = JSON.parse(readFileSync(receipt, "utf8")) as { key: string; files: File[] };
  if (manifest.key !== key) throw new Error("Native-particle cache key mismatch");
  const output = resolve(directory, "output");
  if (JSON.stringify(files(output)) !== JSON.stringify(manifest.files))
    throw new Error("Native-particle cache bytes changed");
  cpSync(output, destination, { recursive: true });
  return true;
}
export function saveParticleCache(root: string, key: string, directory: string, input: unknown) {
  const cache = resolve(root, ".cache/sonolus-native-particles");
  mkdirSync(cache, { recursive: true });
  const temporary = resolve(cache, `${key}.partial-${process.pid}`);
  rmSync(temporary, { recursive: true, force: true });
  cpSync(directory, resolve(temporary, "output"), { recursive: true });
  writeFileSync(
    resolve(temporary, "cache.json"),
    JSON.stringify({ key, input, files: files(directory) }, null, 2) + "\n",
  );
  rmSync(resolve(cache, key), { recursive: true, force: true });
  renameSync(temporary, resolve(cache, key));
}
