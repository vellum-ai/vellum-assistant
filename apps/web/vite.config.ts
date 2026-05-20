import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Reference: https://vite.dev/config/#using-environment-variables-in-config
export default defineConfig(({ mode }) => {
  // loadEnv with empty prefix loads all .env variables, not just VITE_-prefixed ones.
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), "") };

  // Server-only proxy target — never embedded in the client bundle.
  // Reference: https://vite.dev/config/server-options#server-proxy
  const apiProxyTarget = env.API_PROXY_TARGET || "http://localhost:8000";

  return {
    base: "/",
    plugins: [tailwindcss(), react()],
    resolve: {
      alias: {
        "@/": path.resolve(import.meta.dirname, "src") + "/",
      },
      preserveSymlinks: true,
    },
    server: {
      port: parseInt(env.PORT || "3000"),
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
  };
});
