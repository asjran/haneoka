import { defineConfig } from "vite";
export default defineConfig({
  build: {
    lib: { entry: { index: "src/index.ts" }, formats: ["es"], fileName: (_format, name) => name + ".js" },
    minify: false,
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      external: (id) => id.startsWith("@haneoka/") || id.startsWith("@sonolus/") || id === "three" || id === "vue",
    },
  },
});
