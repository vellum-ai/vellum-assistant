/**
 * Default `titleGenerate` pipeline plugin.
 *
 * Declares no middleware — the terminal handler in `./terminal.ts` is wired in
 * as the pipeline's `terminal` argument by the `runPipeline` call site in
 * `daemon/conversation-agent-loop.ts`. This plugin exists purely to negotiate
 * the `titleGenerateApi` capability so bootstrap has a record that the
 * assistant runtime exposes this pipeline.
 *
 * Registered via a side-effect import from
 * `daemon/external-plugins-bootstrap.ts` so it is present in the registry
 * by the time {@link bootstrapPlugins} runs.
 */

import { registerPlugin } from "../../registry.js";
import { type Plugin, PluginExecutionError } from "../../types.js";
import pkg from "./package.json" with { type: "json" };

/**
 * Default titleGenerate plugin. Declares no middleware — it exists purely
 * to negotiate the `titleGenerateApi` capability so bootstrap has a record
 * that the assistant runtime exposes this pipeline.
 *
 * The terminal handler (`./terminal.ts`) is supplied at the call site in
 * `conversation-agent-loop.ts` rather than through `middleware.titleGenerate`,
 * because a default middleware would short-circuit user-registered middleware
 * by always running first in onion order. Keeping the terminal outside the
 * middleware chain lets user plugins observe/transform/short-circuit the
 * call without competing with an assistant-owned default middleware.
 */
export const defaultTitleGeneratePlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
};

// Module-load side effect: register this default at import time so
// downstream consumers (including tests that skip `bootstrapPlugins()`)
// observe a populated registry by default. Idempotent via the swallowed
// duplicate-name check. Kept local to this module (rather than iterating
// an array in `defaults/index.ts`) so the registration only references
// the already-initialized `defaultTitleGeneratePlugin` identifier —
// avoiding a TDZ crash when tests `mock.module(...)` a dependency of any
// other default plugin and directly import this file.
try {
  registerPlugin(defaultTitleGeneratePlugin);
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
