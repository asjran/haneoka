#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] || "verify";
const git = (...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const paths = () =>
  git("config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$")
    .split("\n")
    .map((line) => line.slice(line.indexOf(" ") + 1));
function verify() {
  const status = git("submodule", "status", "--recursive");
  if (status.split("\n").some((line) => /^[+U-]/u.test(line)))
    throw new Error("Submodule checkout differs from the Git pins");
  for (const path of paths()) {
    if (!/^\.dependencies\/[a-z0-9-]+$/u.test(path)) throw new Error(`Invalid dependency path: ${path}`);
    if (git("-C", path, "status", "--porcelain")) throw new Error(`Uncommitted dependency changes: ${path}`);
  }
  console.log("Submodules match their Git pins");
}
try {
  if (command === "checkout") {
    git("submodule", "update", "--init", "--recursive", "--jobs", "4");
    verify();
  } else if (command === "verify") verify();
  else if (command === "update") {
    verify();
    git("submodule", "update", "--remote", "--checkout", "--recursive", "--jobs", "4");
    git("add", "--", ...paths());
    verify();
  } else throw new Error("Use checkout, verify or update");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
