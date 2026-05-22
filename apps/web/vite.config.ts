import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";

// Reference: https://vite.dev/config/#using-environment-variables-in-config
export default defineConfig(({ mode }) => {
  // loadEnv with empty prefix loads all .env variables, not just VITE_-prefixed ones.
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), "") };

  // Server-only proxy target — never embedded in the client bundle.
  // Reference: https://vite.dev/config/server-options#server-proxy
  const apiProxyTarget = env.API_PROXY_TARGET || "http://localhost:8000";

  // Sentry source map upload is opt-in — only runs when SENTRY_AUTH_TOKEN
  // is provided (CI/CD build pipeline). Local dev builds skip it.
  // Reference: https://docs.sentry.io/platforms/javascript/guides/react/sourcemaps/uploading/vite/
  const sentryUploadEnabled = !!env.SENTRY_AUTH_TOKEN;

  return {
    base: "/assistant/",
    plugins: [
      tailwindcss(),
      react(),
      sentryVitePlugin({
        disable: !sentryUploadEnabled,
        org: env.SENTRY_ORG || "vellum",
        project: env.SENTRY_PROJECT || "vellum-assistant-web",
        authToken: env.SENTRY_AUTH_TOKEN,
        release: {
          name: env.SENTRY_RELEASE,
        },
        sourcemaps: {
          filesToDeleteAfterUpload: ["./dist/**/*.map"],
        },
      }),
      // Dev-server SPA fallback for routes that live outside Vite's `base`.
      // With `base: "/assistant/"`, Vite's built-in fallback only serves
      // index.html under `/assistant/*`. React Router intentionally claims
      // `/account/*` and `/logout` at the root (see routes.tsx), so a
      // hard-reload on those URLs would otherwise 404 in dev. Rewriting
      // the request to `/assistant/` makes Vite serve index.html; the
      // browser URL is unchanged, so React Router still matches the
      // original path. Production relies on the deployed server's
      // catch-all fallback (LB → SPA bucket).
      {
        name: "spa-fallback-outside-base",
        configureServer(server) {
          server.middlewares.use((req, _res, next) => {
            const url = req.url ?? "";
            const pathname = url.split("?")[0];
            if (
              pathname === "/account" ||
              pathname.startsWith("/account/") ||
              pathname === "/logout" ||
              pathname.startsWith("/logout/")
            ) {
              req.url = "/assistant/";
            }
            next();
          });
        },
      },
    ],
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
      // Generate source maps only when Sentry upload is enabled (CI/CD).
      // The Sentry plugin deletes .map files after upload, so they never
      // reach the deployed artifact. Without the token, skip generation
      // entirely to avoid shipping maps in non-Sentry builds.
      sourcemap: sentryUploadEnabled ? "hidden" : false,
    },
  };
});
