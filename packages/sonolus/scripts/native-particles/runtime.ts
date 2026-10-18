import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function sourceTree(directory: string): Array<{ path: string; sha256: string }> {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      if (["node_modules", "dist", ".generated"].includes(entry.name)) return [];
      const path = resolve(directory, entry.name);
      return entry.isDirectory()
        ? sourceTree(path).map((file) => ({ ...file, path: `${entry.name}/${file.path}` }))
        : entry.isFile()
          ? [{ path: entry.name, sha256: hash(readFileSync(path)) }]
          : [];
    });
}

/** Compile the pinned particle evaluator independently of the host renderer. */
export function prepareParticleRuntime(root: string, expected: Record<string, string>) {
  const producer = resolve(root, "packages/sonolus/particle-producer");
  const input = sourceTree(producer);
  const key = hash(Buffer.from(JSON.stringify(input)));
  const receiptFile = resolve(producer, ".generated/runtime.json");
  const modules = {
    core: resolve(producer, "core/dist/index.js"),
    renderer: resolve(producer, "renderer/dist/index.js"),
    profile: resolve(producer, "profile/dist/index.js"),
    authored: resolve(producer, "profile/dist/authored.js"),
    contract: fileURLToPath(import.meta.resolve("@haneoka/sonolus-our-notes/contract/native-effects.json")),
  };
  const ready = () =>
    existsSync(resolve(producer, "profile/dist/assets/noteTextures.js")) &&
    Object.entries(modules).every(([name, file]) => existsSync(file) && hash(readFileSync(file)) === expected[name]);
  const output = () =>
    ["core", "profile", "renderer"].flatMap((name) =>
      sourceTree(resolve(producer, name, "dist"))
        .filter((file) => /\.(js|png|json)$/.test(file.path))
        .map((file) => ({ ...file, path: `${name}/dist/${file.path}` })),
    );
  const receipt = existsSync(receiptFile)
    ? (JSON.parse(readFileSync(receiptFile, "utf8")) as { key: string; output: ReturnType<typeof output> })
    : undefined;
  if (receipt?.key !== key || !ready() || JSON.stringify(output()) !== JSON.stringify(receipt.output)) {
    const require = createRequire(resolve(root, ".dependencies/cassiopeia-renderer-three/package.json"));
    const vite = resolve(require.resolve("vite/package.json"), "../bin/vite.js");
    for (const name of ["core", "profile", "renderer"]) {
      const cwd = resolve(producer, name);
      execFileSync(process.execPath, [vite, "build"], { cwd, stdio: ["ignore", "inherit", "inherit"] });
      if (name === "profile")
        execFileSync(process.execPath, ["scripts/copy-note-skin-assets.mjs"], {
          cwd,
          stdio: ["ignore", "inherit", "inherit"],
        });
    }
    if (!ready()) throw new Error("Pinned native-particle runtime build changed");
    mkdirSync(resolve(producer, ".generated"), { recursive: true });
    writeFileSync(
      receiptFile,
      JSON.stringify({ key, input, output: output(), runtimeHashes: expected }, null, 2) + "\n",
    );
  }
  const aliases: Record<string, string> = {
    "@haneoka/cassiopeia": modules.core,
    "@haneoka/cassiopeia/plugin": resolve(producer, "core/dist/plugin.js"),
    "@haneoka/cassiopeia/enums": resolve(producer, "core/dist/enums.js"),
    "@haneoka/cassiopeia/timing-policy": resolve(producer, "core/dist/timing-policy.js"),
    "@haneoka/cassiopeia-plugin-our-notes": modules.profile,
    "@haneoka/cassiopeia-plugin-our-notes/authored": modules.authored,
    "@haneoka/cassiopeia-renderer-three": modules.renderer,
  };
  return {
    modules,
    sourceKey: key,
    input,
    output: output(),
    register: () =>
      registerHooks({
        resolve(specifier, context, next) {
          return aliases[specifier]
            ? { url: pathToFileURL(aliases[specifier]).href, shortCircuit: true }
            : next(specifier, context);
        },
      }),
  };
}
