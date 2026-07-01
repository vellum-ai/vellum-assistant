import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Reference: https://electron-vite.org/config/
//
// No renderer config: the renderer is the clients/web/ Vite project, served in
// dev via http://localhost:5173 and in prod via a custom `app://` protocol.
//
// Dependencies that must be bundled inline rather than externalized as
// runtime `require(...)` calls.
//
// `electron-store` (and its `conf` parent) are ESM-only. electron-vite's
// default externalize plugin would emit `require("electron-store")` in the
// CJS main bundle, which returns the module namespace rather than the
// default export and breaks `new Store(...)`. Bundling their ESM source
// inline lets Rollup handle the CJS interop correctly at bundle time.
//
// `@vellumai/local-mode` (and its `@vellumai/environments` dep) are local
// `file:` packages whose `exports` point at TypeScript source with no build
// step. Externalizing them would emit `require("@vellumai/local-mode")`
// resolving to a `.ts` file the Electron main process can't load at runtime;
// inlining lets Rollup compile the source into the bundle.
const DEPS_TO_INLINE = [
  "electron-log",
  "electron-store",
  "electron-updater",
  "conf",
  "@vellumai/ipc-contract",
  "@vellumai/local-mode",
  "@vellumai/environments",
];

// Resolved at config-evaluation time and inlined into the main bundle via
// Vite's `define`. Prefer the CI-provided GITHUB_SHA (7-char prefix);
// fall back to `git rev-parse --short HEAD` on a developer checkout; emit
// "unknown" when neither is available (e.g. building from a tarball).
const resolveBuildSha = (): string => {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

// Bun version bundled with the app, read from the repo-root `.tool-versions`
// (the same source fetch-bun.sh downloads from). Baked into the main bundle so
// the CLI installer can stamp `packageManager: bun@<version>` on the install it
// writes, marking that install bun-only (see cli-installer.ts, LUM-2649).
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

// Local builds drive the repo CLI source directly instead of installing the
// published package; release builds bake an empty path and keep the pinned
// npm install (see getLocalCliEntry in src/main/cli-installer.ts).
const LOCAL_CLI_ENTRY =
  (process.env.VELLUM_ENVIRONMENT || "local") === "local"
    ? path.resolve(__dirname, "../../cli/src/index.ts")
    : "";

const BUILD_DEFINES = {
  __VELLUM_BUILD_SHA__: JSON.stringify(resolveBuildSha()),
  __VELLUM_ENVIRONMENT__: JSON.stringify(
    process.env.VELLUM_ENVIRONMENT || "local",
  ),
  __VELLUM_LOCAL_CLI_ENTRY__: JSON.stringify(LOCAL_CLI_ENTRY),
  __VELLUM_BUN_VERSION__: JSON.stringify(resolveBunVersion()),
  __VELLUM_ENABLE_CHROME_DEVTOOLS__: JSON.stringify(
    process.env.VELLUM_ENABLE_CHROME_DEVTOOLS === "true" ||
      process.env.VELLUM_ENABLE_CHROME_DEVTOOLS === "1",
  ),
  __SENTRY_DSN_MACOS__: JSON.stringify(process.env.SENTRY_DSN_MACOS || ""),
  // Root hostname (leading dot) shared with the web bundle's
  // VITE_ROOT_HOSTNAME; baked into the CSP source lists (see src/main/csp.ts).
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
    plugins: [externalizeDepsPlugin()],
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
