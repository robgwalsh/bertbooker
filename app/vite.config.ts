import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `root` is set EXPLICITLY, and it is load-bearing. Vite resolves `root` from
// the process's cwd, not from this file's location, so with the single root
// package.json the repo now has — `vite build --config app/vite.config.ts`, run
// from the repo root — the default root would be `<repo>/` and rollup would
// look for `index.html` there and fail. Pinning it to this directory makes the
// command work from anywhere, and makes `dist` land at `app/dist`, which is
// what `[assets] directory` in api/wrangler.toml points at.
//
// In dev the SPA runs on :5173 and proxies `/api` to the API worker (`wrangler
// dev` on :8787). Deployed, that same worker also serves this bundle, so the
// paths already match and no proxy is needed — this exists only to make dev look
// like that one origin, which is also what keeps the `SameSite=Strict` session
// cookie working here exactly as it does in production.
//
// There is nothing else to proxy, and a second prefix would be a trap: it would
// shadow a client route in `app/src/router.tsx` and make that page unreachable.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
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
