#!/usr/bin/env node
// Keeps the Sonolus server toolchain on the @sonolus/* release that matches
// the current Sonolus app. The declared app version (Sonolus-Version response
// header) is baked into @sonolus/core, so trailing npm releases means clients
// see the server as an old-version server.
//
//   check  print available updates, exit 1 when any exist (CI gate)
//   apply  rewrite pnpm-workspace.yaml catalog + engine package.json pins
//
// The engine's package.json lives in the externally locked
// sonolus-our-notes repository; committing, pushing, and updating
// the Git submodule pin is the caller's job (the scheduled
// sonolus-toolchain-update workflow does exactly that).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceFile = join(repositoryRoot, "pnpm-workspace.yaml");
const enginePackageFile = join(repositoryRoot, ".dependencies", "sonolus-our-notes", "package.json");

// package -> where the pin lives. free-pack has no app-version coupling but
// is kept in lockstep so the engine and server never mix release generations.
const catalogPackages = ["@sonolus/core", "@sonolus/express", "@sonolus/free-pack"];
const enginePackages = [
  "@sonolus/core",
  "@sonolus/express",
  "@sonolus/free-pack",
  "@sonolus/sonolus.js",
  "@sonolus/sonolus.js-compiler",
];

const mode = process.argv[2] ?? "check";
if (mode !== "check" && mode !== "apply") {
  console.error(`Unknown mode "${mode}". Use "check" or "apply".`);
  process.exitCode = 2;
} else {
  main();
}

async function main() {
  const current = { ...readCatalogPins(), ...readEnginePins() };
  const updates = [];
  for (const pkg of [...new Set([...catalogPackages, ...enginePackages])]) {
    const latest = await latestVersion(pkg);
    const pinned = current[pkg];
    if (pinned === undefined) throw new Error(`${pkg} is not pinned in the workspace or engine manifests`);
    if (latest !== pinned) updates.push({ pkg, from: pinned, to: latest });
  }
  if (updates.length === 0) {
    console.log("Sonolus toolchain is up to date.");
    return;
  }
  for (const { pkg, from, to } of updates) console.log(`${pkg}: ${from} -> ${to}`);
  if (mode === "check") {
    process.exitCode = 1;
    return;
  }
  const catalogUpdates = new Map(updates.filter((u) => catalogPackages.includes(u.pkg)).map((u) => [u.pkg, u.to]));
  const engineUpdates = new Map(updates.filter((u) => enginePackages.includes(u.pkg)).map((u) => [u.pkg, u.to]));
  if (catalogUpdates.size) rewriteCatalog(catalogUpdates);
  if (engineUpdates.size) rewriteEnginePackage(engineUpdates);
  console.log(
    `Updated ${[...catalogUpdates.keys()].join(", ") || "nothing"} in pnpm-workspace.yaml and ` +
      `${[...engineUpdates.keys()].join(", ") || "nothing"} in the engine manifest; ` +
      `run pnpm install and update the engine submodule pin.`,
  );
}

async function latestVersion(pkg) {
  const response = await fetch(`https://registry.npmjs.org/${pkg}`);
  if (!response.ok) throw new Error(`npm registry lookup failed for ${pkg}: HTTP ${response.status}`);
  const latest = (await response.json())["dist-tags"]?.latest;
  if (typeof latest !== "string") throw new Error(`npm registry has no latest tag for ${pkg}`);
  return latest;
}

function readCatalogPins() {
  const pins = {};
  for (const line of readLines(workspaceFile)) {
    for (const pkg of catalogPackages) {
      const match = new RegExp(`^\\s*"${pkg}":\\s*(\\d+\\.\\d+\\.\\d+)\\s*$`).exec(line);
      if (match) pins[pkg] = match[1];
    }
  }
  return pins;
}

function readEnginePins() {
  const manifest = JSON.parse(readFileSync(enginePackageFile, "utf8"));
  const pins = {};
  for (const section of ["dependencies", "devDependencies"]) {
    for (const pkg of enginePackages) {
      const value = manifest[section]?.[pkg];
      if (typeof value === "string") pins[pkg] = value;
    }
  }
  return pins;
}

function rewriteCatalog(updates) {
  const lines = readLines(workspaceFile);
  const rewritten = lines.map((line) => {
    for (const [pkg, version] of updates) {
      line = line.replace(new RegExp(`(\\s*"${pkg}":\\s*)\\d+\\.\\d+\\.\\d+\\s*$`), `$1${version}`);
    }
    return line;
  });
  writeFileSync(workspaceFile, rewritten.join("\n"));
}

function rewriteEnginePackage(updates) {
  const manifest = JSON.parse(readFileSync(enginePackageFile, "utf8"));
  for (const section of ["dependencies", "devDependencies"]) {
    for (const [pkg, version] of updates) {
      if (manifest[section]?.[pkg] !== undefined) manifest[section][pkg] = version;
    }
  }
  writeFileSync(enginePackageFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

function readLines(path) {
  return readFileSync(path, "utf8").split("\n");
}
