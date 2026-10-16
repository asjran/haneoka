import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isBuiltin } from "node:module";
import { build } from "esbuild";

const SCHEMA = "haneoka-model-render-epoch-v1";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const slash = (value) => value.replaceAll("\\", "/");

export function modelRenderCachePlugin(root) {
  const file = path.join(root, ".astro/model-render-epoch.json");
  const require = createRequire(path.join(root, "package.json"));
  const names = new Map();
  function name(input) {
    const relative = path.relative(root, input);
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return slash(relative);
    let directory = path.dirname(input);
    while (directory !== path.dirname(directory)) {
      let pkg = names.get(directory);
      if (pkg === undefined) {
        const manifest = path.join(directory, "package.json");
        pkg = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")) : null;
        names.set(directory, pkg);
      }
      if (pkg?.name && pkg?.version) return `package:${pkg.name}@${pkg.version}/${slash(path.relative(directory, input))}`;
      directory = path.dirname(directory);
    }
    throw new Error(`Unidentified model renderer input: ${input}`);
  }
  return {
    name: "model-render-cache-epoch",
    buildStart() { fs.rmSync(file, { force: true }); },
    async generateBundle() {
      try {
        const entry = [...this.getModuleIds()].find((id) => slash(id).endsWith("/src/server/render-model-workspace.ts"));
        if (!entry) return;
        const seen = new Set(), project = [], external = new Set();
        const visit = (id) => {
          if (seen.has(id)) return;
          seen.add(id);
          const info = this.getModuleInfo(id);
          if (!info) throw new Error(`Missing model renderer module: ${id}`);
          if (info.isExternal) {
            if (!isBuiltin(id)) external.add(id);
            return;
          }
          const source = id.split("?", 1)[0];
          const messages = slash(source).startsWith(`${slash(root)}/public/i18n/`) && source.endsWith(".json");
          if (!messages) {
            if (typeof info.code !== "string") throw new Error(`Missing model renderer code: ${id}`);
            const label = fs.existsSync(source) ? name(source) + id.slice(source.length) : slash(id).replaceAll(slash(root), "<workspace>");
            project.push([label, sha256(info.code.replaceAll(root, "<workspace>"))]);
          }
          for (const dependency of [...info.importedIds, ...info.dynamicallyImportedIds]) visit(dependency);
        };
        visit(entry);
        const runtime = new Map();
        const addFile = (input) => runtime.set(name(input), sha256(fs.readFileSync(input)));
        for (const leaf of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "astro.config.mjs", "config/cubism-runtime.lock.json", "scripts/build/model-render-cache.mjs"]) addFile(path.join(root, leaf));
        const imports = [...external].sort();
        if (imports.some((id) => id.startsWith("astro:"))) addFile(require.resolve("astro/package.json"));
        const dependencies = imports.filter((id) => !id.startsWith("astro:"));
        if (dependencies.length) {
          const result = await build({
            stdin: { contents: dependencies.map((id) => `import ${JSON.stringify(id)};`).join("\n"), resolveDir: root, sourcefile: "model-render-runtime" },
            absWorkingDir: root,
            bundle: true,
            platform: "node",
            format: "esm",
            treeShaking: false,
            write: false,
            metafile: true,
            logLevel: "silent",
          });
          for (const input of Object.keys(result.metafile.inputs)) if (input !== "model-render-runtime") addFile(path.resolve(root, input));
        }
        const content = {
          project: project.sort(([a], [b]) => a.localeCompare(b)),
          runtime: [...runtime].sort(([a], [b]) => a.localeCompare(b)),
          external: imports,
        };
        const record = { schema: SCHEMA, epoch: sha256(JSON.stringify(content)), ...content };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(record));
        this.info(`Model renderer cache: ${content.project.length} modules, ${content.runtime.length} runtime inputs`);
      } catch (error) {
        fs.rmSync(file, { force: true });
        this.warn(`Model renderer cache disabled: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
