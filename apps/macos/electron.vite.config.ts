import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Reference: https://electron-vite.org/config/
//
// No renderer config: the renderer is the apps/web/ Vite project, served in
// dev via http://localhost:5173 and in prod via a custom `app://` protocol.
//
// `electron-store` (and its `conf` parent) are ESM-only. electron-vite's
// default externalize plugin would emit `require("electron-store")` in the
// CJS main bundle, which returns the module namespace rather than the
// default export and breaks `new Store(...)`. Excluding them from
// externalization tells Rollup to bundle their ESM source inline, where the
// CJS interop is handled correctly at bundle time.
const ESM_ONLY_DEPS_TO_INLINE = ["electron-store", "conf"];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ESM_ONLY_DEPS_TO_INLINE })],
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
