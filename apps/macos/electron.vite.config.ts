import { execSync } from "node:child_process";

import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Reference: https://electron-vite.org/config/
//
// No renderer config: the renderer is the apps/web/ Vite project, served in
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
// `@vellumai/cli` ships as TypeScript source (no compiled entry point), so
// an externalized `require("@vellumai/cli/...")` could not resolve at
// runtime. Bundling it inline compiles the imported lifecycle functions
// (`hatchLocal` and the small set of pure helpers they transitively pull in)
// into the main bundle alongside the rest of the main process.
const DEPS_TO_INLINE = ["electron-store", "conf", "@vellumai/cli"];

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

const BUILD_SHA_DEFINE = {
  __VELLUM_BUILD_SHA__: JSON.stringify(resolveBuildSha()),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: DEPS_TO_INLINE })],
    define: BUILD_SHA_DEFINE,
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
