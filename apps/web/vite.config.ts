import path from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const BASE = "/assistant/";

/**
 * Redirect /assistant → /assistant/ so the browser gets a proper 301 instead
 * of Vite's default "did you mean /assistant/?" HTML interstitial page.
 */
function basePathRedirect(): Plugin {
  return {
    name: "base-path-redirect",
    configureServer(server) {
      const pathWithoutSlash = BASE.slice(0, -1);
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        const qsIndex = url.indexOf("?");
        const pathname = qsIndex === -1 ? url : url.slice(0, qsIndex);
        if (pathname === pathWithoutSlash) {
          const qs = qsIndex === -1 ? "" : url.slice(qsIndex);
          res.writeHead(301, { Location: `${BASE}${qs}` });
          res.end();
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  base: BASE,
  plugins: [basePathRedirect(), tailwindcss(), react()],
  resolve: {
    alias: {
      "@/": path.resolve(import.meta.dirname, "src") + "/",
    },
  },
  server: {
    port: 3001,
    strictPort: true,
    host: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
