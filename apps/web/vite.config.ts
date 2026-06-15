import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { rmSync } from "node:fs";
import type http from "node:http";
import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import { localModePlugin } from "./vite-plugin-local-mode";

const DESIGN_LIBRARY_SRC = path.resolve(
  import.meta.dirname,
  "../../packages/design-library/src",
);

// Keep in sync with PLATFORM_MODE_TRUTHY in src/lib/local-mode.ts
const PLATFORM_MODE_TRUTHY = new Set(["1", "true", "yes"]);
function isPlatformMode(raw: string | undefined): boolean {
  return !!raw && PLATFORM_MODE_TRUTHY.has(raw.toLowerCase());
}

/**
 * Proxy configure hook that rewrites the localhost `sessionid` cookie
 * into both `sessionid` and `__Secure-sessionid` so the platform's
 * Django session middleware recognises it regardless of which cookie
 * name is configured (dev vs production).
 *
 * Only used in local mode — platform mode proxies without rewriting.
 */
function forwardSessionCookie(proxy: { on: (event: string, cb: (...args: unknown[]) => void) => void }): void {
  proxy.on("proxyReq", (...args: unknown[]) => {
    const proxyReq = args[0] as http.ClientRequest;
    const req = args[1] as http.IncomingMessage;
    const cookie = req.headers.cookie ?? "";
    const match = /sessionid=([^;]+)/.exec(cookie);
    if (match?.[1]) {
      proxyReq.setHeader("Cookie", `sessionid=${match[1]}; __Secure-sessionid=${match[1]}`);
    }
  });
}

// Reference: https://vite.dev/config/#using-environment-variables-in-config
export default defineConfig(({ mode }) => {
  // loadEnv with empty prefix loads all .env variables, not just VITE_-prefixed ones.
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), "") };

  // Server-only proxy targets — never embedded in the client bundle.
  // Reference: https://vite.dev/config/server-options#server-proxy
  const apiProxyTarget = env.API_PROXY_TARGET || "http://localhost:8000";
  const gatewayProxyTarget = env.GATEWAY_PROXY_TARGET || "http://localhost:7830";

  // Only enable Sentry source map upload for deploy builds.
  // Reference: https://docs.sentry.io/platforms/javascript/guides/react/sourcemaps/uploading/vite/
  const sentryUploadEnabled = env.SENTRY_UPLOAD_SOURCE_MAPS === "true";
  if (sentryUploadEnabled && !env.SENTRY_AUTH_TOKEN) {
    throw new Error("SENTRY_AUTH_TOKEN is required to upload Sentry source maps.");
  }
  if (sentryUploadEnabled) {
    if (!env.VITE_APP_VERSION) {
      throw new Error("VITE_APP_VERSION is required to upload Sentry source maps.");
    }
  }

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
          name: env.VITE_APP_VERSION,
          inject: false,
        },
        sourcemaps: {
          filesToDeleteAfterUpload: ["./dist/**/*.map"],
        },
      }),
      isPlatformMode(env.VITE_PLATFORM_MODE) ? null : localModePlugin(env),
      {
        // design-library is a prebundled `file:` dep (see preserveSymlinks
        // below): its source modules are NOT in the served module graph —
        // they're baked into node_modules/.vite/deps, and Vite's optimizer
        // cache key ignores linked-dep contents, so editing design-library
        // never invalidates the prebundle (an ordinary HMR update can't reach
        // those modules either). To pick up an edit we drop the dep cache and
        // let the restart re-optimize from current source. Chokidar won't
        // follow the file: symlink under preserveSymlinks, so the source tree
        // is added to the watcher explicitly. (Only "change" fires here —
        // server.watcher.add() emits "add" for existing files on its initial
        // scan, which would restart on every boot.) The cold-start equivalent,
        // a prebundle left stale by a pull/branch switch, is handled before
        // vite starts by scripts/ensure-fresh-vite.ts in the `dev` script.
        name: "watch-design-library",
        configureServer(server) {
          server.watcher.add(DESIGN_LIBRARY_SRC);
          server.watcher.on("change", (file) => {
            if (!file.startsWith(DESIGN_LIBRARY_SRC)) return;
            rmSync(path.join(server.config.cacheDir, "deps"), {
              recursive: true,
              force: true,
            });
            void server.restart();
          });
        },
      },
    ].filter(Boolean),
    resolve: {
      alias: [
        {
          find: /^@\//,
          replacement: path.resolve(import.meta.dirname, "src") + "/",
        },
      ],
      dedupe: ["react", "react-dom"],
      preserveSymlinks: true,
    },
    server: {
      port: parseInt(env.PORT || "3000"),
      strictPort: true,
      host: true,
      // With preserveSymlinks, static assets referenced from design-library
      // CSS (the @font-face files in tokens.css) resolve to their real path
      // under packages/design-library — outside Vite's auto-detected root
      // (apps/web) — and get blocked in dev. Allow both roots explicitly.
      fs: {
        allow: [import.meta.dirname, DESIGN_LIBRARY_SRC],
      },
      proxy: {
        ...(isPlatformMode(env.VITE_PLATFORM_MODE) ? {
          "/v1": { target: apiProxyTarget, changeOrigin: true },
          "/_allauth": { target: apiProxyTarget, changeOrigin: true },
        } : {
          "/v1": { target: apiProxyTarget, changeOrigin: true, configure: forwardSessionCookie },
          "/_allauth": { target: apiProxyTarget, changeOrigin: true, configure: forwardSessionCookie },
        }),
        "/accounts": { target: apiProxyTarget, changeOrigin: true },
        "/auth": { target: gatewayProxyTarget, changeOrigin: true },
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
