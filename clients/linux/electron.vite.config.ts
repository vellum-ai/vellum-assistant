import { readFileSync } from "node:fs";
import path from "node:path";

import { defineConfig, externalizeDepsPlugin } from "electron-vite";

import { SHARED_DESKTOP_INLINE_DEPS } from "../../packages/electron-desktop/src/inline-deps";

import { resolveShortBuildCommitSha } from "./scripts/build-metadata";

// Reference: https://electron-vite.org/config/
//
// No renderer config: the renderer is the clients/web/ Vite project, served in
// dev via http://localhost:5173 and in prod via a custom `app://` protocol.
const DEPS_TO_INLINE = [
  ...SHARED_DESKTOP_INLINE_DEPS,
  "electron-updater",
  "@vellumai/native-sidecar",
];

const resolveBunVersion = (): string => {
  try {
    const toolVersions = readFileSync(
      path.resolve(__dirname, "../../.tool-versions"),
      "utf8",
    );
    return toolVersions.match(/^bun\s+(\S+)/m)?.[1] ?? "";
  } catch {
    return "";
  }
};

const LOCAL_CLI_ENTRY =
  (process.env.VELLUM_ENVIRONMENT || "local") === "local"
    ? path.resolve(__dirname, "../../cli/src/index.ts")
    : "";

const BUILD_DEFINES = {
  __VELLUM_BUILD_SHA__: JSON.stringify(resolveShortBuildCommitSha()),
  __VELLUM_ENVIRONMENT__: JSON.stringify(
    process.env.VELLUM_ENVIRONMENT || "local",
  ),
  __VELLUM_LOCAL_CLI_ENTRY__: JSON.stringify(LOCAL_CLI_ENTRY),
  __VELLUM_BUN_VERSION__: JSON.stringify(resolveBunVersion()),
  __VELLUM_ENABLE_CHROME_DEVTOOLS__: JSON.stringify(
    process.env.VELLUM_ENABLE_CHROME_DEVTOOLS === "true" ||
      process.env.VELLUM_ENABLE_CHROME_DEVTOOLS === "1",
  ),
  __SENTRY_DSN_LINUX__: JSON.stringify(process.env.SENTRY_DSN_LINUX || ""),
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
