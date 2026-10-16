import runtimeLock from "../../config/cubism-runtime.lock.json";

function runtimeUrl(source: string): string {
  const file = runtimeLock.files.find((entry) => entry.source === source);
  if (!file?.output) throw new Error(`Missing Cubism runtime file: ${source}`);
  return `/${file.output}?v=${file.sha256}`;
}

// Runtime URLs must change with the locked bytes: an older cached adapter
// cannot satisfy the current viewer's method contract.
export const CUBISM_WEB_RUNTIME_URL = runtimeUrl("Framework/vega-cubism-web-runtime.mjs");
let runtimeModule: Promise<unknown> | undefined;
let failedImports = 0;

export function loadCubismWebRuntime<T = unknown>(): Promise<T> {
  if (!runtimeModule) {
    const url = new URL(CUBISM_WEB_RUNTIME_URL, document.baseURI);
    if (failedImports) url.searchParams.set("retry", String(failedImports));
    runtimeModule = import(/* @vite-ignore */ url.href).catch((error: unknown) => {
      runtimeModule = undefined;
      failedImports++;
      throw error;
    });
  }
  return runtimeModule as Promise<T>;
}

export const CUBISM_CORE_URLS = {
  cubismCoreUrl: runtimeUrl("Core/live2dcubismcore.js"),
  cubism2CoreUrl: runtimeUrl("Core/live2d.min.js"),
  motionSyncCoreUrl: runtimeUrl("Core/CRI/live2dcubismmotionsynccore.min.js"),
};
