/**
 * Default `toolExecute` plugin — a no-argument passthrough that preserves
 * the behavior `ToolExecutor.execute` had before the pipeline wrapper was
 * introduced.
 *
 * Design
 * ------
 * The public {@link ToolExecutor.execute} method invokes
 * {@link runPipeline} with the terminal bound to an internal
 * `executeInternal` method (the original execute body, refactored to avoid
 * recursion). Because the terminal IS the original behavior, the default
 * plugin's `middleware.toolExecute` is a thin passthrough: it forwards to
 * `next(args)` and returns the downstream result unchanged.
 *
 * This matches the convention set by PR 15 (`default-llm-call.ts`) for
 * `llmCall` — the default plugin makes the pipeline shape explicit without
 * introducing any behavior of its own. When no third-party plugins are
 * registered the chain is `[defaultMiddleware] → terminal`, which composes
 * identically to `[] → terminal`, so the shell-integration tests (which
 * never register the default) stay unchanged-green.
 *
 * Why a dedicated plugin at all?
 * ------------------------------
 * - It signals publicly that `toolExecute` is a supported pipeline slot with
 *   a concrete contract.
 * - Registration order determines onion order. If a third-party plugin
 *   wraps `toolExecute`, the runtime should boot with the default present
 *   (as the innermost passthrough) so the chain visibly contains a
 *   canonical terminator regardless of which third parties load.
 */

import { registerPlugin } from "../registry.js";
import {
  type Middleware,
  type Plugin,
  PluginExecutionError,
  type ToolExecuteArgs,
  type ToolExecuteResult,
} from "../types.js";

/**
 * Passthrough middleware — forwards the call to `next`. Named so the
 * pipeline runner's `chain` log entry reads `defaultToolExecute` instead of
 * `anonymous`.
 */
const defaultToolExecute: Middleware<ToolExecuteArgs, ToolExecuteResult> =
  async function defaultToolExecute(args, next) {
    return next(args);
  };

/**
 * The default `toolExecute` plugin. Exported as a module constant so the
 * daemon bootstrap can register it via a side-effect import. Tests may
 * import and register it explicitly via `registerPlugin()` to cover the
 * on-by-default execution path.
 */
export const defaultToolExecutePlugin: Plugin = {
  manifest: {
    name: "default-tool-execute",
    version: "1.0.0",
    provides: { toolExecuteApi: "v1" },
    requires: { pluginRuntime: "v1", toolExecuteApi: "v1" },
  },
  middleware: {
    toolExecute: defaultToolExecute,
  },
};

// Module-load side effect: register this default at import time so
// downstream consumers (including tests that skip `bootstrapPlugins()`)
// observe a populated registry by default. Idempotent via the swallowed
// duplicate-name check. Kept local to this module (rather than iterating
// an array in `defaults/index.ts`) so the registration only references
// the already-initialized `defaultToolExecutePlugin` identifier —
// avoiding a TDZ crash when tests `mock.module(...)` a dependency of any
// other default plugin and directly import this file.
try {
  registerPlugin(defaultToolExecutePlugin);
} catch (err) {
  if (
    err instanceof PluginExecutionError &&
    err.message.includes("already registered")
  ) {
    // already registered — expected when both index.ts and the direct
    // file are imported in the same process
  } else {
    throw err;
  }
}
