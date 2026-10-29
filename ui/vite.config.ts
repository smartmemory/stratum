import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Standalone shell. `npm run dev` proxies /api to the local server (ui/server/serve.mjs) on
// STRATUM_UI_API_PORT; `npm run build` emits ui/dist, which serve.mjs --static can host alone.
const apiPort = process.env.STRATUM_UI_API_PORT;
const devPort = Number(process.env.STRATUM_UI_DEV_PORT) || undefined;

export default defineConfig({
  root: "shell",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: devPort,
    strictPort: true,
    proxy: apiPort ? { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } } : undefined,
  },
});
