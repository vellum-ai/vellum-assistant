import type http from "node:http";
import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { localModePlugin } from "./vite-plugin-local-mode";

const DESIGN_LIBRARY_SRC = path.resolve(
  import.meta.dirname,
  "../../packages/design-library/src",
);
// With preserveSymlinks, the module graph keys by the node_modules symlink
// path, not the real source path. We need both to translate watcher events.
const DESIGN_LIBRARY_SYMLINK = path.resolve(
  import.meta.dirname,
  "node_modules/@vellum/design-library/src",
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
        // Chokidar won't follow the file: symlink when preserveSymlinks
        // is true, so manually add the design-library source tree.
        // handleHotUpdate translates the real path to the symlink path
        // so the module graph lookup finds the right modules.
        name: "watch-design-library",
        configureServer(server) {
          server.watcher.add(DESIGN_LIBRARY_SRC);
        },
        handleHotUpdate({ file, server }) {
          if (!file.startsWith(DESIGN_LIBRARY_SRC)) return;
          const rel = path.relative(DESIGN_LIBRARY_SRC, file);
          const symlinkPath = path.resolve(DESIGN_LIBRARY_SYMLINK, rel);
          const mods = server.moduleGraph.getModulesByFile(symlinkPath);
          if (mods?.size) return [...mods];
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
      preserveSymlinks: true,
    },
    server: {
      port: parseInt(env.PORT || "3000"),
      strictPort: true,
      host: true,
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
