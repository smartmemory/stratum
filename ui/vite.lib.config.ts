import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

// Library build for the published @smartmemory/stratum-ui (STRAT-COMPONENTS-PUBLISH-1): ESM entries
// in dist/ (index, data-client, builder), declarations from tsconfig.build.json, and the plain
// src/styles.css copied as dist/styles.css. React stays external (peer dependency), so the host's one
// React copy renders the screens. The standalone shell builds with vite.config.ts (`npm run build:shell`).
const external = (id: string) => /^(react|react-dom)(\/|$)/.test(id) || /^@dagrejs\/dagre(\/|$)/.test(id);

function stylesAsset(): Plugin {
  return {
    name: "stratum-ui-styles",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "styles.css", source: readFileSync(resolve(__dirname, "src/styles.css"), "utf8") });
    },
  };
}

export default defineConfig({
  plugins: [react(), stylesAsset()],
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        "data-client": resolve(__dirname, "src/data-client.ts"),
        builder: resolve(__dirname, "src/builder/index.js"),
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external,
      output: { chunkFileNames: "chunks/[name]-[hash].js" },
    },
  },
});
