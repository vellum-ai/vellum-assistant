import { defineConfig, externalizeDepsPlugin } from "electron-vite";

import { resolveShortBuildCommitSha } from "./scripts/build-metadata";

// Reference: https://electron-vite.org/config/
//
// No renderer config: the renderer is the clients/web/ Vite project, served in
// dev via http://localhost:5173 and in prod via a custom `app://` protocol.
//
// Dependencies that must be bundled inline rather than externalized as
// runtime `require(...)` calls.
//
// Workspace dependencies such as `@vellumai/local-mode` and
// `@vellumai/electron-utils` export TypeScript source with no build step.
// Inlining lets Rollup compile their source into the bundle.
const DEPS_TO_INLINE = [
  "electron-log",
  "electron-store",
  "conf",
  "@vellumai/electron-utils",
  "@vellumai/electron-desktop",
  "@vellumai/ipc-contract",
  "@vellumai/local-mode",
  "@vellumai/native-sidecar",
  "@vellumai/environments",
];

const BUILD_DEFINES = {
  __VELLUM_BUILD_SHA__: JSON.stringify(resolveShortBuildCommitSha()),
  __VELLUM_ENVIRONMENT__: JSON.stringify(
    process.env.VELLUM_ENVIRONMENT || "local",
  ),
  __VELLUM_ENABLE_CHROME_DEVTOOLS__: JSON.stringify(
    process.env.VELLUM_ENABLE_CHROME_DEVTOOLS === "true" ||
      process.env.VELLUM_ENABLE_CHROME_DEVTOOLS === "1",
  ),
  __SENTRY_DSN_WINDOWS__: JSON.stringify(process.env.SENTRY_DSN_WINDOWS || ""),
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
