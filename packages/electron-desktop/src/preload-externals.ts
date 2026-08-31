import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Modules a sandboxed preload is allowed to `require(...)` at runtime.
 * Electron's sandbox polyfills only a tiny set; anything else throws at load
 * and kills the whole preload script, so `window.vellum` is never exposed
 * (the renderer then loses window dragging, traffic-light clearance, and
 * every other bridge-gated feature). Keep this to `electron` unless a new
 * sandbox-safe module is deliberately added.
 */
export const ALLOWED_PRELOAD_EXTERNALS = ["electron"];

/** Distinct module ids from bare `require("...")` calls in a built bundle. */
export const scanExternalRequires = (bundleSource: string): string[] => {
  const externals = new Set<string>();
  for (const match of bundleSource.matchAll(/\brequire\((["'])([^"']+)\1\)/g)) {
    externals.add(match[2]);
  }
  return [...externals].sort();
};

/**
 * Build a desktop client with electron-vite and return the external requires
 * left in its emitted preload bundle. A dependency missing from the client's
 * `DEPS_TO_INLINE` shows up here, so tests can fail it before it ships.
 */
export const buildPreloadAndScanExternals = async (
  clientRoot: string,
): Promise<string[]> => {
  const proc = Bun.spawn(["bunx", "electron-vite", "build"], {
    cwd: clientRoot,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  if ((await proc.exited) !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`electron-vite build failed in ${clientRoot}:\n${stderr}`);
  }
  const bundle = await readFile(
    path.join(clientRoot, "out/preload/index.js"),
    "utf8",
  );
  return scanExternalRequires(bundle);
};
