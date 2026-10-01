#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "public/embed");
const virtualOutput = path.join(output, ".bundle");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const metadataArg = process.argv.find((arg) => arg.startsWith("--metadata="));
const metadataPath = metadataArg ? path.resolve(metadataArg.slice("--metadata=".length)) : undefined;
if (metadataPath?.startsWith(path.join(root, "public") + path.sep))
  throw new Error("Build metadata belongs outside public");
const regenerate = process.argv.includes("--regenerate");
if (
  process.argv.some(
    (arg) => arg.startsWith("--") && arg !== metadataArg && arg !== "--regenerate" && arg !== "--verify",
  )
)
  throw new Error("Usage: node scripts/build-embeds.mjs [--verify | --regenerate [--metadata=/absolute/report.json]]");
if (regenerate && process.argv.includes("--verify")) throw new Error("Choose verify or regenerate");
if (!regenerate) {
  if (metadataArg) throw new Error("--metadata records regeneration inputs; use --regenerate explicitly");
  const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
  if (!/^r-[a-f0-9]{16}$/u.test(manifest.release)) throw new Error("Invalid frozen embed release");
  const releaseDirectory = path.join(output, manifest.release);
  const ordered = Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b, "en"));
  for (const [name, expected] of ordered) {
    const target = path.resolve(releaseDirectory, name);
    if (!target.startsWith(output + path.sep)) throw new Error(`Embed file outside distribution: ${name}`);
    const bytes = await readFile(target);
    if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256)
      throw new Error(`Frozen embed artifact mismatch: ${name}`);
  }
  const releaseHash = hash(ordered.map(([name, value]) => `${name}\0${value.sha256}\n`).join(""));
  if (releaseHash !== manifest.sha256 || `r-${releaseHash.slice(0, 16)}` !== manifest.release)
    throw new Error("Frozen embed release digest mismatch");
  for (const [name, target] of Object.entries(manifest.modules)) {
    if (target !== `./${manifest.release}/${name}.js`) throw new Error(`Invalid embed module target: ${name}`);
    if ((await readFile(path.join(output, `${name}.js`), "utf8")) !== `export * from "${target}";\n`)
      throw new Error(`Frozen embed alias mismatch: ${name}`);
  }
  console.log(`Verified frozen /embed/${manifest.release}/ (${ordered.length} files); regeneration not requested`);
  process.exit(0);
}

// Approved embed sources; rendering peers use their existing production exports.
const sourceEntries = new Map();
for (const name of ["core", "vega", "cassiopeia", "home-spot"]) {
  const source = path.join(root, `packages/embed-${name}/src`);
  sourceEntries.set(`@haneoka/embed-${name}`, path.join(source, "index.ts"));
  sourceEntries.set(`@haneoka/embed-${name}/haneoka`, path.join(source, "haneoka.ts"));
}
sourceEntries.set("@haneoka/embed-core/branding", path.join(root, "packages/embed-core/src/branding.ts"));
sourceEntries.set("@haneoka/embed-vega/theme", path.join(root, "packages/embed-vega/src/theme.ts"));
for (const entry of ["index", "haneoka"])
  sourceEntries.set(
    `@haneoka/api-client${entry === "index" ? "" : "/haneoka"}`,
    path.join(root, `packages/api-client/src/${entry}.ts`),
  );

const packages = new Map();
for (const relative of [
  ".dependencies/vega",
  ".dependencies/vega/packages/protocol",
  ".dependencies/vega-renderer-three",
  ".dependencies/vega-plugin-cubism",
  ".dependencies/vega-plugin-haneoka",
  ".dependencies/vega-plugin-richtext",
  ".dependencies/vega-theme-haneoka",
  ".dependencies/vega-shell-default",
  ".dependencies/vega-ui-portable",
  ".dependencies/cassiopeia",
  ".dependencies/cassiopeia-host-web",
  ".dependencies/cassiopeia-plugin-our-notes",
  ".dependencies/cassiopeia-renderer-three",
  ".dependencies/cassiopeia-ui-vue",
]) {
  const directory = path.join(root, relative);
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  packages.set(manifest.name, { directory, manifest });
}
const chartStyle = await readFile(path.join(root, "packages/embed-cassiopeia/src/style.css"), "utf8");
const entries = {
  core: `export * from "@haneoka/embed-core";export * from "@haneoka/embed-core/haneoka";export * from "@haneoka/embed-core/branding";`,
  vega: `export * from "@haneoka/embed-vega";export * from "@haneoka/embed-vega/haneoka";`,
  "home-spot": `export * from "@haneoka/embed-home-spot";export * from "@haneoka/embed-home-spot/haneoka";`,
  "vega-theme": `export * from "@haneoka/embed-vega/theme";`,
  cassiopeia: `
    import {mountChart as originalMount} from "@haneoka/embed-cassiopeia";
    export * from "@haneoka/embed-cassiopeia/haneoka";
    const styles=new WeakMap();
    export function mountChart(container,options){
      if(!container?.ownerDocument?.defaultView)throw new TypeError("A browser container is required");
      const document=container.ownerDocument;
      let sheet=styles.get(document);
      if(!sheet){const element=document.createElement("style");element.textContent=${JSON.stringify(chartStyle)};element.dataset.haneokaChartEmbedStyles="";document.head.append(element);sheet={element,count:0};styles.set(document,sheet);}
      sheet.count++;
      let released=false;
      const release=()=>{if(released)return;released=true;if(--sheet.count===0){sheet.element.remove();styles.delete(document);}};
      let handle;try{handle=originalMount(container,options);}catch(error){release();throw error;}
      const dispose=handle.dispose.bind(handle);let disposal;
      handle.dispose=()=>{
        if(disposal)return disposal;
        try{disposal=Promise.resolve(dispose()).finally(release);}catch(error){release();disposal=Promise.reject(error);}
        return disposal;
      };
      return handle;
    }
  `,
};
const assets = new Map();
const consumedInputs = new Map();
const assetPlugin = {
  name: "embed-distribution",
  setup(builder) {
    builder.onResolve({ filter: /^embed-entry:/ }, (args) => ({ path: args.path.slice(12), namespace: "embed-entry" }));
    builder.onLoad({ filter: /.*/, namespace: "embed-entry" }, (args) => ({
      contents: entries[args.path],
      loader: "js",
      resolveDir: root,
    }));
    builder.onResolve({ filter: /^@haneoka\// }, async (args) => {
      if (sourceEntries.has(args.path)) return { path: sourceEntries.get(args.path) };
      const [, name, subpath = ""] = /^(@haneoka\/[^/]+)(\/.*)?$/u.exec(args.path) ?? [];
      const item = packages.get(name);
      if (!item) return undefined;
      const value = item.manifest.exports?.[subpath ? `.${subpath}` : "."];
      const target = typeof value === "string" ? value : (value?.import ?? value?.default);
      if (!target) throw new Error(`Missing runtime export ${args.path}`);
      const file = path.resolve(item.directory, target);
      await access(file).catch(() => {
        throw new Error(`Build the producer before publishing embeds: ${args.path} → ${file}`);
      });
      return { path: file };
    });
    builder.onResolve({ filter: /^embed-asset:/ }, (args) => ({ path: args.path.slice(12), namespace: "embed-asset" }));
    builder.onLoad({ filter: /.*/, namespace: "embed-asset" }, async (args) => {
      const bytes = await readFile(args.path);
      assets.set(path.relative(root, args.path), { bytes: bytes.length, sha256: hash(bytes) });
      return { contents: bytes, loader: "file" };
    });
    builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
      const code = await readFile(args.path, "utf8");
      consumedInputs.set(path.relative(root, args.path), hash(code));
      const loader = /\.[cm]?ts$/u.test(args.path) ? "ts" : "js";
      const unchanged = { contents: code, loader, resolveDir: path.dirname(args.path) };
      if (!code.includes("import.meta.url")) return unchanged;
      const source = ts.createSourceFile(args.path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const edits = [],
        imports = [];
      const visit = (node) => {
        if (
          ts.isNewExpression(node) &&
          node.expression.getText(source) === "URL" &&
          node.arguments?.length === 2 &&
          ts.isStringLiteralLike(node.arguments[0]) &&
          node.arguments[1].getText(source) === "import.meta.url"
        ) {
          const value = node.arguments[0].text;
          if (value.startsWith(".")) {
            const file = path.resolve(path.dirname(args.path), value);
            const id = `__embed_asset_${imports.length}`;
            imports.push(`import ${id} from ${JSON.stringify(`embed-asset:${file}`)};`);
            edits.push({ start: node.arguments[0].getStart(source), end: node.arguments[0].end, value: id });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (!edits.length) return unchanged;
      let rewritten = code;
      for (const edit of edits.reverse())
        rewritten = rewritten.slice(0, edit.start) + edit.value + rewritten.slice(edit.end);
      return { contents: imports.join("\n") + "\n" + rewritten, loader, resolveDir: path.dirname(args.path) };
    });
  },
};

const result = await build({
  entryPoints: Object.keys(entries).map((name) => ({ in: `embed-entry:${name}`, out: name })),
  absWorkingDir: root,
  outdir: virtualOutput,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
  metafile: true,
  legalComments: "linked",
  charset: "utf8",
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "../assets/[name]-[hash]",
  loader: { ".wasm": "file", ".woff2": "file", ".png": "file", ".svg": "file" },
  nodePaths: [path.join(root, "node_modules")],
  plugins: [assetPlugin],
  logLevel: "warning",
});
const files = new Map(
  result.outputFiles.map((file) => [
    path.relative(virtualOutput, file.path).split(path.sep).join("/"),
    Buffer.from(file.contents),
  ]),
);
const assetBytes = [...assets.values()].reduce((sum, file) => sum + file.bytes, 0);
if (assetBytes > 64 * 1024 * 1024)
  throw new Error(`Embed asset closure exceeds the 64 MiB distribution budget: ${assetBytes}`);
// Preserve dependency licenses once per distribution, alongside linked legal comments.
const licenseDirectories = new Map([...packages].map(([name, value]) => [name, value.directory]));
for (const name of ["embed-core", "embed-vega", "embed-cassiopeia", "embed-home-spot", "api-client"])
  licenseDirectories.set(`@haneoka/${name}`, path.join(root, `packages/${name}`));
for (const input of Object.keys(result.metafile.inputs)) {
  const matches = [...input.matchAll(/(?:^|\/)node_modules\/(@[^/]+\/[^/]+|[^/]+)/gu)];
  const match = matches.at(-1);
  if (match) licenseDirectories.set(match[1], path.resolve(root, input.slice(0, match.index + match[0].length)));
}
for (const [name, directory] of licenseDirectories) {
  for (const basename of [
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "LICENSE-SCOPE.md",
    "THIRD_PARTY_NOTICES.md",
    "NOTICE.md",
  ]) {
    try {
      files.set(`licenses/${name.replaceAll("/", "-")}-${basename}`, await readFile(path.join(directory, basename)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
for (const [name, sha256] of consumedInputs) {
  if (hash(await readFile(path.resolve(root, name))) !== sha256)
    throw new Error(`Source changed while building embed artifacts: ${name}`);
}
const ordered = [...files].sort(([left], [right]) => left.localeCompare(right, "en"));
const releaseHash = hash(ordered.map(([name, bytes]) => `${name}\0${hash(bytes)}\n`).join(""));
const release = `r-${releaseHash.slice(0, 16)}`;
const releaseDirectory = path.join(output, release);
await mkdir(releaseDirectory, { recursive: true });
for (const [name, bytes] of ordered) {
  const target = path.join(releaseDirectory, name);
  await mkdir(path.dirname(target), { recursive: true });
  let current;
  try {
    current = await readFile(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (current && !current.equals(bytes)) throw new Error(`Content-addressed embed artifact mismatch: ${name}`);
  if (!current) await writeFile(target, bytes);
}
const manifest = {
  schemaVersion: 1,
  release,
  sha256: releaseHash,
  modules: Object.fromEntries(Object.keys(entries).map((name) => [name, `./${release}/${name}.js`])),
  files: Object.fromEntries(ordered.map(([name, bytes]) => [name, { bytes: bytes.length, sha256: hash(bytes) }])),
};
await writeFile(path.join(releaseDirectory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
// Replace each stable alias atomically; its complete hashed dependency closure already exists.
for (const name of Object.keys(entries)) {
  const target = path.join(output, `${name}.js`),
    temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `export * from "./${release}/${name}.js";\n`);
  await rename(temporary, target);
}
const temporary = path.join(output, `manifest.json.tmp-${process.pid}`);
await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n");
await rename(temporary, path.join(output, "manifest.json"));
if (metadataArg) {
  const report = metadataPath;
  const inputHashes = Object.fromEntries(consumedInputs);
  await writeFile(
    report,
    JSON.stringify(
      {
        ...manifest,
        assetBytes,
        assets: Object.fromEntries(assets),
        inputs: inputHashes,
        metafile: result.metafile,
        chartStylesInlined: true,
      },
      null,
      2,
    ),
  );
}
console.log(`Static embed files prepared: /embed/${release}/ (${files.size} files; ${assetBytes} asset bytes)`);
