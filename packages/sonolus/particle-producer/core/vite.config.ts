import { defineConfig } from "vite";
export default defineConfig({
  cacheDir: ".generated/vite",
  build: {
    lib: {
      entry: { "wasm-session": "src/wasm-session.ts", index: "src/index.ts", plugin: "src/plugin.ts", enums: "src/enums-entry.ts", "timing-policy": "src/timing-policy-entry.ts" },
      formats: ["es"],
      fileName: (_format, name) => name + ".js",
    },
    minify: false,
    sourcemap: true,
    target: "es2022",
  },
});
