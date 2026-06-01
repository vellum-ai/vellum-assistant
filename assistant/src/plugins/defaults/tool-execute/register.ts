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

import { type Plugin } from "../../types.js";
import defaultToolExecute from "./middlewares/toolExecute.js";
import pkg from "./package.json" with { type: "json" };

/**
 * The default `toolExecute` plugin. Exported as a module constant that the
 * defaults aggregator registers centrally; tests may register it explicitly to
 * cover the on-by-default execution path.
 */
export const defaultToolExecutePlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
  middleware: {
    toolExecute: defaultToolExecute,
  },
};
