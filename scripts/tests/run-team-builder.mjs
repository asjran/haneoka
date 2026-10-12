import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "haneoka-team-search-"));
try {
  const outfile = join(directory, "team-search.test.mjs");
  await build({ entryPoints: ["scripts/tests/team-builder-search.test.ts"], outfile, bundle: true, platform: "node", format: "esm", target: "node24" });
  const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), outfile], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
