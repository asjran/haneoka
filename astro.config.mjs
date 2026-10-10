import { defineConfig } from "astro/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";

const root = path.dirname(fileURLToPath(import.meta.url));
/** Identifies one deployment; an open tab compares it with /build.json to offer a reload. */
const buildId = String(process.env.GITHUB_SHA || Date.now()).slice(0, 12);
const proxyTarget = String(process.env.LOCAL_WORKER_ORIGIN || process.env.LOCAL_RELEASE_ORIGIN || "").trim();

export default defineConfig({
  site: "https://haneoka.org",
  output: "static",
  outDir: path.join(root, ".output/public"),
  publicDir: path.join(root, ".generated-public"),
  compressHTML: true,
  // View-transition navigations prefetch the next document while the pointer
  // is still on the link — on a high-latency link that head start is most of
  // the perceived page load.
  prefetch: true,
  build: { inlineStylesheets: "auto" },
  integrations: [
    {
      name: "build-id",
      hooks: {
        "astro:build:done": async ({ dir }) => {
          await writeFile(new URL("build.json", dir), JSON.stringify({ id: buildId }));
        },
      },
    },
  ],
  vite: {
    define: { __BUILD_ID__: JSON.stringify(buildId) },
    worker: { format: "es" },
    build: {
      cssMinify: "lightningcss",
      target: "es2022",
      rollupOptions: {
        output: {
          manualChunks(id) {
            // Rollup pulls a manual chunk's unassigned dependencies into it.
            // The dynamic-import preload helper is such a dependency of the
            // flowchart, and every lazy import site on the site references
            // it, so leaving it unassigned made each page statically load
            // the flowchart and, through it, three and the Vega renderer.
            if (id.includes("vite/preload-helper") || id.includes("vite/modulepreload-polyfill"))
              return "preload-helper";
            if (id.includes("/.dependencies/vega-shell-default/dist/flowchart-")) return "vega-flowchart";
            if (id.includes("/node_modules/three/") || id.includes("/node_modules/.pnpm/three@")) return "three-core";
            if (id.includes("/.dependencies/vega/packages/protocol/")) return "vega-protocol";
            if (id.includes("/.dependencies/vega-renderer-three/")) return "vega-three-renderer";
          },
        },
      },
    },
    resolve: { dedupe: ["lit"] },
    server: {
      watch: { ignored: ["**/data/**", "**/tmp/**", "**/.dependencies/**/target/**"] },
      ...(proxyTarget
        ? {
            proxy: {
              "/api": { target: proxyTarget, changeOrigin: true },
              "/assets": { target: proxyTarget, changeOrigin: true },
              "/objects": { target: proxyTarget, changeOrigin: true },
              "/runtime": { target: proxyTarget, changeOrigin: true },
              "/sonolus": { target: proxyTarget, changeOrigin: true },
            },
          }
        : {}),
    },
  },
});
