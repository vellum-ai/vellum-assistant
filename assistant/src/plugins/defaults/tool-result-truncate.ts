/**
 * Default `toolResultTruncate` plugin.
 *
 * Wraps the pre-existing `truncateToolResultText` helper from
 * `context/tool-result-truncation.ts` in a plugin middleware so every
 * tool-result truncation goes through the shared pipeline runner. The
 * default behavior is byte-for-byte identical to calling
 * `truncateToolResultText` directly; plugins registered ahead of this one
 * can short-circuit with their own truncation strategy (e.g. a summariser
 * that preserves semantics better than a tail-drop).
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
 * Default terminal middleware — delegates to `truncateToolResultText` and
 * reports whether the call actually shortened the input. The `truncated`
 * flag lets callers warn/telemeter without re-measuring the output.
 *
 * Exported so tests can assert identity / default behavior without standing
 * up the full plugin registry.
 */
export const defaultToolResultTruncateMiddleware: Middleware<
  ToolResultTruncateArgs,
  ToolResultTruncateResult
> = async (args, _next, _ctx) => {
  const truncated = truncateToolResultText(args.content, args.maxChars);
  return {
    content: truncated,
    truncated: truncated !== args.content,
  };
};

/**
 * Plugin descriptor for the default tool-result truncation middleware.
 * Registered by `daemon/external-plugins-bootstrap.ts` so the registry
 * always has at least one middleware for the `toolResultTruncate` pipeline.
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
    toolResultTruncate: defaultToolResultTruncateMiddleware,
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
