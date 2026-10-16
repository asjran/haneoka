import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { staticPageGroupEnabled } from "../../src/server/static-build.ts";

if (!process.argv.includes("--repair-from-log") && !staticPageGroupEnabled("provider")) {
  console.log("Provider detail generation belongs to a separate static page family.");
  process.exit(0);
}

const output = path.join(process.cwd(), ".output", "build", "provider-static.mjs");
const entry = process.argv.includes("--repair-from-log") ? "scripts/build/provider-static-repair.ts" : "scripts/build/provider-static.ts";
await build({ entryPoints: [entry], outfile: output, bundle: true, platform: "node", format: "esm", packages: "external" });
await import(pathToFileURL(output).href);
