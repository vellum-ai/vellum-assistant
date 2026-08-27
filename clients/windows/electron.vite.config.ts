import { createRequire } from "node:module";

import { defineConfig, externalizeDepsPlugin } from "electron-vite";

import { SHARED_DESKTOP_INLINE_DEPS } from "../../packages/electron-desktop/src/inline-deps";

import { resolveShortBuildCommitSha } from "./scripts/build-metadata";

// Reference: https://electron-vite.org/config/
//
// No renderer config: the renderer is the clients/web/ Vite project, served in
// dev via http://localhost:5173 and in prod via a custom `app://` protocol.
//
// Dependencies that must be bundled inline rather than externalized as
// runtime `require(...)` calls. The cross-client rules (and the sandboxed
// preload rationale) live in the shared list; Windows also starts its native
// helper through the local sidecar package. Guarded by
// scripts/preload-externals.test.ts.
const DEPS_TO_INLINE = [
  ...SHARED_DESKTOP_INLINE_DEPS,
  "@vellumai/native-sidecar",
];

// The installer shortcut and `app.setAppUserModelId` must agree, so the
// builder config is the single source of the id.
const { appId } = createRequire(import.meta.url)(
  "./electron-builder.config.cjs",
) as { appId: string };

const BUILD_DEFINES = {
  __VELLUM_APP_USER_MODEL_ID__: JSON.stringify(appId),
  __VELLUM_BUILD_SHA__: JSON.stringify(resolveShortBuildCommitSha()),
  __VELLUM_ENVIRONMENT__: JSON.stringify(
    process.env.VELLUM_ENVIRONMENT || "local",
  ),
  __VELLUM_ENABLE_CHROME_DEVTOOLS__: JSON.stringify(
    process.env.VELLUM_ENABLE_CHROME_DEVTOOLS === "true" ||
      process.env.VELLUM_ENABLE_CHROME_DEVTOOLS === "1",
  ),
  __SENTRY_DSN_WINDOWS__: JSON.stringify(process.env.SENTRY_DSN_WINDOWS || ""),
  __VELLUM_ROOT_HOSTNAME__: JSON.stringify(
    process.env.VITE_ROOT_HOSTNAME || ".vellum.ai",
  ),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: DEPS_TO_INLINE })],
    define: BUILD_DEFINES,
    build: {
      outDir: "out/main",
      lib: {
        entry: "src/main/index.ts",
      },
      rollupOptions: {
        external: ["electron"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: DEPS_TO_INLINE })],
    build: {
      outDir: "out/preload",
      lib: {
        entry: "src/preload/index.ts",
      },
      rollupOptions: {
        external: ["electron"],
      },
    },
  },
});
