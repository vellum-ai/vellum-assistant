import type { Resvg as ResvgType } from "@resvg/resvg-js";

let ResvgClass: typeof ResvgType | undefined;

/**
 * Returns the Resvg constructor, loading the native module on first call.
 * Defers the native-addon require so the daemon can start even when the
 * platform-specific binary is unavailable (e.g. inside a bun --compile
 * single-file executable).
 */
export function getResvg(): typeof ResvgType {
  if (!ResvgClass) {
    // Inline require is necessary here: @resvg/resvg-js loads a platform-specific
    // native .node addon at import time. A top-level import would crash the daemon
    // on startup inside bun --compile binaries where native addons are unavailable.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@resvg/resvg-js") as typeof import("@resvg/resvg-js");
    ResvgClass = mod.Resvg;
  }
  return ResvgClass;
}
