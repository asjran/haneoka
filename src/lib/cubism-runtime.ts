import runtimeLock from "../../config/cubism-runtime.lock.json";

function runtimeUrl(output: string): string {
  const file = runtimeLock.files.find((entry) => entry.output === output);
  if (!file) throw new Error(`Missing Cubism runtime file: ${output}`);
  return `/${output}?v=${file.sha256}`;
}

// Runtime URLs must change with the locked bytes: an older cached adapter
// cannot satisfy the current viewer's method contract.
export const CUBISM_WEB_RUNTIME_URL = runtimeUrl("cubism-runtime/vega-cubism-web-runtime.mjs");
export const CUBISM_CORE_URLS = {
  cubismCoreUrl: runtimeUrl("Core/live2dcubismcore.js"),
  cubism2CoreUrl: runtimeUrl("Core/live2d.min.js"),
  motionSyncCoreUrl: runtimeUrl("Core/CRI/live2dcubismmotionsynccore.min.js"),
};
