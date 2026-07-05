import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type http from "node:http";
import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import {
  localModePlugin,
  getDevPlatformToken,
  isSameOriginProxyRequest,
} from "./vite-plugin-local-mode";

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
 * Proxy configure hook (local mode) that authenticates upstream requests with
 * the loopback platform session token the SPA registered. No browser cookie is
 * involved.
 *
 * The DRF API (`/v1`) authenticates by header (X-Session-Token); sending a
 * `sessionid` cookie would engage Django's SessionAuthentication, which enforces
 * CSRF and rejects unsafe (POST/PUT/PATCH) requests when the proxy can't supply
 * a matching Origin/Referer. The allauth / accounts session endpoints need the
 * Django session cookie instead.
 */
function injectPlatformToken(apiMode: boolean) {
  return (proxy: {
    on: (event: string, cb: (...args: unknown[]) => void) => void;
  }): void => {
    proxy.on("proxyReq", (...args: unknown[]) => {
      const proxyReq = args[0] as http.ClientRequest;
      const req = args[1] as http.IncomingMessage;
      if (!isSameOriginProxyRequest(req)) return;
      const token = getDevPlatformToken();
      if (apiMode) {
        // Header-only auth; drop any browser cookie so it can't re-engage the
        // session-cookie (CSRF-enforcing) path.
        proxyReq.removeHeader("Cookie");
        // Server-side proxy injection of the loopback token, not browser auth —
        // the centralized interceptor can't reach this Node proxy hook.
        // eslint-disable-next-line no-restricted-syntax
        if (token) proxyReq.setHeader("X-Session-Token", token);
        return;
      }
      if (token) {
        proxyReq.setHeader(
          "Cookie",
          `sessionid=${token}; __Secure-sessionid=${token}`,
        );
      }
    });
  };
}

// Reference: https://vite.dev/config/#using-environment-variables-in-config
export default defineConfig(({ mode }) => {
  // loadEnv with empty prefix loads all .env variables, not just VITE_-prefixed ones.
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), "") };

  // Server-only proxy targets — never embedded in the client bundle.
  // Reference: https://vite.dev/config/server-options#server-proxy
  const apiProxyTarget = env.API_PROXY_TARGET || "http://localhost:8000";
  const gatewayProxyTarget =
    env.GATEWAY_PROXY_TARGET || "http://localhost:7830";

  // Only enable Sentry source map upload for deploy builds.
  // Reference: https://docs.sentry.io/platforms/javascript/guides/react/sourcemaps/uploading/vite/
  const sentryUploadEnabled = env.SENTRY_UPLOAD_SOURCE_MAPS === "true";
  if (sentryUploadEnabled && !env.SENTRY_AUTH_TOKEN) {
    throw new Error(
      "SENTRY_AUTH_TOKEN is required to upload Sentry source maps.",
    );
  }
  if (sentryUploadEnabled) {
    if (!env.VITE_APP_VERSION) {
      throw new Error(
        "VITE_APP_VERSION is required to upload Sentry source maps.",
      );
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
        // The plugin fails the build by default when a source-map upload errors.
        // Builds that set SENTRY_ALLOW_UPLOAD_FAILURE (the Electron release /
        // dev-release packaging) downgrade that to a warning, so a Sentry outage
        // or auth-token scope miss ships an unsymbolicated build rather than
        // breaking the release. Builds without the flag (the web SPA deploy) keep
        // failing fast so a missing upload is caught before shipping.
        ...(env.SENTRY_ALLOW_UPLOAD_FAILURE === "true"
          ? {
              errorHandler: (err: Error) =>
                console.warn(
                  `[sentry-vite-plugin] source map upload failed: ${err.message}`,
                ),
            }
          : {}),
        release: {
          name: env.VITE_APP_VERSION,
          inject: false,
        },
        sourcemaps: {
          filesToDeleteAfterUpload: ["./dist/**/*.map"],
        },
      }),
      isPlatformMode(env.VITE_PLATFORM_MODE) ? null : localModePlugin(env),
    ].filter(Boolean),
    resolve: {
      alias: [
        {
          find: /^@\//,
          replacement: path.resolve(import.meta.dirname, "src") + "/",
        },
      ],
      dedupe: ["react", "react-dom"],
    },
    optimizeDeps: {
      // Deep `@vellumai/design-library/components/*` imports resolve to .tsx
      // source, which the dep optimizer won't auto-prebundle — those modules
      // are served raw. A bare import in a raw-served module is rewritten to
      // a prebundled chunk only when the specifier is already in the
      // optimized set; otherwise it resolves into design-library's nested
      // node_modules and is served untransformed, and any CommonJS module in
      // that chain (e.g. micromark's `debug`) is a browser SyntaxError →
      // white screen in dev. List every bare specifier that design-library
      // source imports but clients/web source does not import itself.
      include: ["rehype-katex", "remark-math", "remark-parse", "unified"],
    },
    server: {
      port: parseInt(env.PORT || "3000"),
      strictPort: true,
      host: true,
      // design-library is a workspace sibling: its source and the @font-face
      // asset URLs in tokens.css resolve to packages/design-library, outside
      // Vite's auto-detected root (clients/web). Allow both roots explicitly.
      fs: {
        allow: [import.meta.dirname, DESIGN_LIBRARY_SRC],
      },
      proxy: {
        ...(isPlatformMode(env.VITE_PLATFORM_MODE)
          ? {
              "/v1": { target: apiProxyTarget, changeOrigin: true },
              "/_allauth": { target: apiProxyTarget, changeOrigin: true },
              "/accounts": { target: apiProxyTarget, changeOrigin: true },
            }
          : {
              "/v1": {
                target: apiProxyTarget,
                changeOrigin: true,
                configure: injectPlatformToken(true),
              },
              "/_allauth": {
                target: apiProxyTarget,
                changeOrigin: true,
                configure: injectPlatformToken(false),
              },
              "/accounts": {
                target: apiProxyTarget,
                changeOrigin: true,
                configure: injectPlatformToken(false),
              },
            }),
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
