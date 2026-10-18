import { defineConfig } from "vite";
export default defineConfig({
  build: {
    lib: {
      entry: { index: "src/index.ts", authored: "src/authored.ts" },
      formats: ["es"],
      fileName: (_format, name) => name + ".js",
    },
    minify: false,
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      // Preserve static asset URLs for the consuming application bundler.
      // Library mode otherwise embeds every PNG in this package's JS.
      external: (id) =>
        id === "./noteTextures.js" ||
        id === "./gekisouStageSource.js" ||
        id.startsWith("@haneoka/") ||
        id.startsWith("@sonolus/") ||
        id === "three" ||
        id === "vue",
    },
  },
});
