import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Where the Vite dev server proxies API requests. Only used at dev
// time — never embedded in the client bundle (no VITE_ prefix).
// Reference: https://vite.dev/config/server-options#server-proxy
const apiProxyTarget =
  process.env.API_PROXY_TARGET || "http://localhost:8000";

export default defineConfig({
  base: "/",
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@/": path.resolve(import.meta.dirname, "src") + "/",
    },
    preserveSymlinks: true,
  },
  server: {
    port: parseInt(process.env.PORT || "3000"),
    strictPort: true,
    host: true,
    proxy: {
      "/v1": { target: apiProxyTarget, changeOrigin: true },
      "/_allauth": { target: apiProxyTarget, changeOrigin: true },
      "/accounts": { target: apiProxyTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
