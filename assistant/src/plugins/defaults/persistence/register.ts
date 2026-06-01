/**
 * Default `persistence` plugin.
 *
 * The plugin's middleware is a passthrough — it calls `next(args)` and returns
 * the result unchanged. The actual dispatch lives in the terminal handler in
 * `./terminal.ts`, which is wired in as the pipeline's `terminal` argument by
 * `runPipeline` call sites in `daemon/conversation-agent-loop.ts` and
 * `daemon/conversation-agent-loop-handlers.ts`. This separation matters: the
 * default plugin is registered before any user plugin (defaults load first in
 * `bootstrapPlugins()`), which puts it at the OUTERMOST position of the onion
 * chain. If the default middleware were to invoke the terminal directly
 * without calling `next`, it would shadow every later-registered plugin.
 * Routing through `next(args)` lets user middleware participate normally.
 *
 * Manifest declares `provides.persistence: "v1"` so other plugins can
 * negotiate against the pipeline surface and `requires.pluginRuntime: "v1"`
 * to satisfy the registry's mandatory capability check.
 *
 * Registered from `daemon/external-plugins-bootstrap.ts` via a side-effect
 * import so the plugin is present in the registry before
 * {@link bootstrapPlugins} walks it.
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 27).
 */

import { registerPlugin } from "../../registry.js";
import {
  type Middleware,
  type PersistArgs,
  type PersistResult,
  type Plugin,
  PluginExecutionError,
} from "../../types.js";
import pkg from "./package.json" with { type: "json" };

const passthrough: Middleware<PersistArgs, PersistResult> = async (
  args,
  next,
) => next(args);

export const defaultPersistencePlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
  middleware: {
    persistence: passthrough,
  },
};

// Module-load side effect: register this default at import time so
// downstream consumers (including tests that skip `bootstrapPlugins()`)
// observe a populated registry by default. Idempotent via the swallowed
// duplicate-name check. Kept local to this module (rather than iterating
// an array in `defaults/index.ts`) so the registration only references
// the already-initialized `defaultPersistencePlugin` identifier —
// avoiding a TDZ crash when tests `mock.module(...)` a dependency of any
// other default plugin and directly import this file.
try {
  registerPlugin(defaultPersistencePlugin);
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
