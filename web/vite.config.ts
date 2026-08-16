import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev the SPA runs on :5173 and proxies `/api` to the API worker (`wrangler
// dev` on :8787). Deployed, that same worker also serves this bundle, so the
// paths already match and no proxy is needed — this exists only to make dev look
// like that one origin, which is also what keeps the `SameSite=Strict` session
// cookie working here exactly as it does in production.
//
// There is nothing else to proxy. Local gathering (`npm run gather`) is a CLI
// that POSTs to the worker itself; it has no UI and no port of its own.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
