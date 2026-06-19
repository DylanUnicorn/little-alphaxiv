import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";

// Dev server proxies /api -> backend FastAPI on :8000 (the CORS proxy).
// In production you'd serve frontend + backend from the same origin.

// We develop in git worktrees (.claude/worktrees/<name>), and each worktree's
// frontend/node_modules is a junction to the MAIN repo's node_modules. Vite
// realpath-resolves that junction, so deps live outside the worktree dev-server
// root and get served via /@fs/<main-repo-abs-path>/. With the default
// server.fs.strict guard, those /@fs/ paths are blocked with HTTP 403 — which
// breaks the pdf.js worker (loaded via `...?url` → workerSrc) and any other
// dep Vite serves through the junction. Allow the real node_modules location
// explicitly. process.cwd() is the dev root (the frontend dir) in both main
// and worktree runs; realpath follows the junction to the same target either
// way, so this is a no-op on main and the fix in a worktree. Setting fs.allow
// replaces Vite's default list, so re-include the dev root (process.cwd()) —
// otherwise in-root source files like /src/main.tsx get 403'd too.
const nodeModulesReal = fs.realpathSync(
  path.resolve(process.cwd(), "node_modules"),
);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind IPv4 loopback explicitly. Vite's default host is "localhost", which
    // on Windows resolves to ::1 (IPv6) only — so the server listens on
    // [::1]:5173 and IPv4 127.0.0.1:5173 is refused (ERR_CONNECTION_REFUSED),
    // even though localhost:5173 works. Pinning 127.0.0.1 makes the IPv4
    // address work directly, keeps localhost working (browsers fall back to
    // 127.0.0.1 when ::1 refuses), and matches tools/drive.py, which hardcodes
    // http://127.0.0.1:5173 for the E2E rig. Loopback-only: not exposed to LAN.
    host: "127.0.0.1",
    fs: {
      allow: [process.cwd(), nodeModulesReal],
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
});
