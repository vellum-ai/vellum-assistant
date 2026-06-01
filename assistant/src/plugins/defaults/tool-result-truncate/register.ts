/**
 * Default `toolResultTruncate` plugin.
 *
 * The plugin's middleware is a passthrough — it calls `next(args)` and returns
 * the result unchanged. The actual truncation lives in the terminal handler in
 * `./terminal.ts`, which is wired in as the pipeline's `terminal` argument by
 * the `runPipeline` call site in `agent/loop.ts`. This separation matters: the
 * default plugin is registered before any user plugin (defaults load first in
 * `bootstrapPlugins()`), which puts it at the OUTERMOST position of the onion
 * chain. If the default
 * middleware were to invoke the terminal directly without calling `next`, it
 * would shadow every later-registered plugin (including hot-reloaded ones).
 * Routing through `next(args)` lets user middleware participate normally.
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 17).
 */

import { type Plugin } from "../../types.js";
import toolResultTruncate from "./middlewares/toolResultTruncate.js";
import pkg from "./package.json" with { type: "json" };

/**
 * Plugin descriptor for the default tool-result truncation middleware.
 * Registered by `plugins/defaults/index.ts` so the registry always has at
 * least one middleware for the `toolResultTruncate` pipeline.
 */
export const defaultToolResultTruncatePlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
  middleware: {
    toolResultTruncate,
  },
};
