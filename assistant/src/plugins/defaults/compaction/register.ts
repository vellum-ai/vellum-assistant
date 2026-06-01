/**
 * Default `compaction` plugin.
 *
 * The plugin's middleware is a passthrough — it calls `next(args)` and returns
 * the result unchanged. The actual compaction lives in the terminal handler in
 * `./terminal.ts`, which is wired in as the pipeline's `terminal` argument by
 * the `runPipeline` call site in `daemon/conversation-agent-loop.ts`. This
 * separation matters: the default plugin is registered before any user plugin
 * (defaults load first in `bootstrapPlugins()`), which puts it at the
 * OUTERMOST position of the onion chain. If the default middleware were to
 * invoke the terminal directly without calling `next`, it would shadow every
 * later-registered plugin. Routing through `next(args)` lets user middleware
 * participate normally.
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 25).
 */

import { registerPlugin } from "../../registry.js";
import { type Plugin, PluginExecutionError } from "../../types.js";
import defaultCompactionMiddleware from "./middlewares/compaction.js";
import pkg from "./package.json" with { type: "json" };

/**
 * Manifest + middleware wiring for the default compaction plugin. The
 * registration happens in `daemon/external-plugins-bootstrap.ts` before
 * {@link bootstrapPlugins} fires plugin `init()` hooks.
 */
export const defaultCompactionPlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
  middleware: {
    compaction: defaultCompactionMiddleware,
  },
};

// Module-load side effect: register this default at import time so
// downstream consumers (including tests that skip `bootstrapPlugins()`)
// observe a populated registry by default. Idempotent via the swallowed
// duplicate-name check. Kept local to this module (rather than iterating
// an array in `defaults/index.ts`) so the registration only references
// the already-initialized `defaultCompactionPlugin` identifier —
// avoiding a TDZ crash when tests `mock.module(...)` a dependency of any
// other default plugin and directly import this file.
try {
  registerPlugin(defaultCompactionPlugin);
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
