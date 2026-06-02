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

import { type Plugin } from "../../types.js";
import defaultToolErrorMiddleware from "./middlewares/toolError.js";
import pkg from "./package.json" with { type: "json" };

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
