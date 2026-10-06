import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";

const settingsPath = process.env.SHALE_SETTINGS_PATH ?? new URL("../settings.json", import.meta.url);
const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
const hostOrigin = `http://127.0.0.1:${Number(settings.PORT ?? process.env.PORT) || 7425}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: hostOrigin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq, req) => {
            // Vite is a trusted local proxy; preserve the daemon's same-origin guard.
            if (req.headers.origin === `http://${req.headers.host}` && /^(localhost|127\.0\.0\.1):\d+$/.test(req.headers.host ?? "")) {
              proxyReq.setHeader("origin", hostOrigin);
            }
          });
        },
      },
    },
  },
});
