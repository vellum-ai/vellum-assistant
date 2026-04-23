/**
 * Default `toolResultTruncate` plugin.
 *
 * The plugin's middleware is a passthrough — it calls `next(args)` and returns
 * the result unchanged. The actual truncation lives in
 * {@link defaultToolResultTruncateTerminal}, which is wired in as the
 * pipeline's `terminal` argument by the `runPipeline` call site in
 * `agent/loop.ts`. This separation matters: the default plugin is registered
 * before any user plugin (defaults load first in `bootstrapPlugins()`), which
 * puts it at the OUTERMOST position of the onion chain. If the default
 * middleware were to invoke the terminal directly without calling `next`, it
 * would shadow every later-registered plugin (including hot-reloaded ones).
 * Routing through `next(args)` lets user middleware participate normally.
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 17).
 */

import { truncateToolResultText } from "../../context/tool-result-truncation.js";
import { registerPlugin } from "../registry.js";
import {
  type Middleware,
  type Plugin,
  PluginExecutionError,
  type ToolResultTruncateArgs,
  type ToolResultTruncateResult,
} from "../types.js";

/**
 * Terminal handler for the `toolResultTruncate` pipeline. Exported so tests
 * can verify default behavior directly without going through `runPipeline`,
 * and so `agent/loop.ts` can pass it as the `terminal` argument to
 * `runPipeline`.
 */
export function defaultToolResultTruncateTerminal(
  args: ToolResultTruncateArgs,
): ToolResultTruncateResult {
  const truncated = truncateToolResultText(args.content, args.maxChars);
  return {
    content: truncated,
    truncated: truncated !== args.content,
  };
}

const passthrough: Middleware<
  ToolResultTruncateArgs,
  ToolResultTruncateResult
> = async (args, next) => next(args);

/**
 * Plugin descriptor for the default tool-result truncation middleware.
 * Registered by `plugins/defaults/index.ts` so the registry always has at
 * least one middleware for the `toolResultTruncate` pipeline.
 */
export const defaultToolResultTruncatePlugin: Plugin = {
  manifest: {
    name: "default-tool-result-truncate",
    version: "1.0.0",
    requires: {
      pluginRuntime: "v1",
      toolResultTruncateApi: "v1",
    },
  },
  middleware: {
    toolResultTruncate: passthrough,
  },
};

// Module-load side effect: register this default at import time so
// downstream consumers (including tests that skip `bootstrapPlugins()`)
// observe a populated registry by default. Idempotent via the swallowed
// duplicate-name check. Kept local to this module (rather than iterating
// an array in `defaults/index.ts`) so the registration only references
// the already-initialized `defaultToolResultTruncatePlugin` identifier —
// avoiding a TDZ crash when tests `mock.module(...)` a dependency of any
// other default plugin and directly import this file.
try {
  registerPlugin(defaultToolResultTruncatePlugin);
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
