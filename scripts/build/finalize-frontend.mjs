#!/usr/bin/env node
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import * as pagefind from "pagefind";
import { copyCalendarStaticAssets } from "./calendar-static-assets.mjs";

const output = path.resolve(".output/public");
const calendarImages = await copyCalendarStaticAssets({ outputRoot: output });
if (calendarImages) console.log(`finalized ${calendarImages} generated calendar images`);
// The Cubism declaration is useful to developers but is not a browser asset
// and is intentionally outside the runtime's exact production file set.
for (const relative of ["Core/CRI/live2dcubismmotionsynccore.d.ts"]) {
  const target = path.join(output, relative);
  if (existsSync(target)) unlinkSync(target);
}
console.log("finalized browser-only public output");

const { index, errors } = await pagefind.createIndex({
  excludeSelectors: ["script", "style", "button", "input", "select", "[aria-hidden=true]", ".audio-dock"],
});
if (errors?.length || !index) throw new Error(`Search index initialization failed: ${errors?.join("; ")}`);
try {
  const result = await index.addDirectory({ path: output });
  if (result.errors.length) throw new Error(`Search indexing failed: ${result.errors.join("; ")}`);
  const written = await index.writeFiles({ outputPath: path.join(output, "pagefind") });
  if (written.errors.length) throw new Error(`Search output failed: ${written.errors.join("; ")}`);
  console.log(`indexed ${result.page_count} pages for global search`);
} finally {
  await index.deleteIndex();
  await pagefind.close();
}
