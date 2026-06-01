/**
 * Default `toolError` plugin.
 *
 * The plugin's middleware is a passthrough — it calls `next(args)` and returns
 * the result unchanged. The actual nudge-decision logic lives in the terminal
 * handler in `./terminal.ts`, which is wired in as the pipeline's `terminal`
 * argument by the `runPipeline` call site in `agent/loop.ts`. This separation
 * matters: the default plugin is registered before any user plugin (defaults
 * load first via module-side-effect imports / `registerDefaultPlugins`), which
 * puts it at the OUTERMOST position of the onion chain. If the default
 * middleware invoked the decision logic directly without calling `next`, it
 * would shadow every later-registered plugin. Routing through `next(args)`
 * lets user middleware participate normally.
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 19).
 */

import { registerPlugin } from "../../registry.js";
import {
  type Middleware,
  type Plugin,
  PluginExecutionError,
  type ToolErrorArgs,
  type ToolErrorDecision,
} from "../../types.js";
import pkg from "./package.json" with { type: "json" };

/**
 * Default middleware for the `toolError` slot. Passthrough — calls `next(args)`
 * so later-registered user plugins still participate in the onion chain. The
 * actual decision logic lives in the terminal handler in `./terminal.ts`,
 * wired in at the `runPipeline` call site in `agent/loop.ts`.
 *
 * Named explicitly so the pipeline's structured log record carries
 * `"defaultToolErrorMiddleware"` in `chain` instead of an anonymous entry.
 */
const defaultToolErrorMiddleware: Middleware<ToolErrorArgs, ToolErrorDecision> =
  async function defaultToolErrorMiddleware(args, next) {
    return next(args);
  };

/**
 * Plugin registration for the default `toolError` behavior. Registered by
 * `daemon/external-plugins-bootstrap.ts` via a side-effect import so the
 * middleware is available to the pipeline runner from daemon startup.
 */
export const defaultToolErrorPlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
  middleware: {
    toolError: defaultToolErrorMiddleware,
  },
};

// Module-load side effect: register this default at import time so
// downstream consumers (including tests that skip `bootstrapPlugins()`)
// observe a populated registry by default. Idempotent via the swallowed
// duplicate-name check. Kept local to this module (rather than iterating
// an array in `defaults/index.ts`) so the registration only references
// the already-initialized `defaultToolErrorPlugin` identifier —
// avoiding a TDZ crash when tests `mock.module(...)` a dependency of any
// other default plugin and directly import this file.
try {
  registerPlugin(defaultToolErrorPlugin);
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
