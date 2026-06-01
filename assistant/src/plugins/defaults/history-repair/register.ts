/**
 * Default `historyRepair` plugin.
 *
 * The plugin's middleware is a passthrough — it calls `next(args)` and returns
 * the result unchanged. The actual repair lives in the terminal handler in
 * `./terminal.ts`, which is wired in as the pipeline's `terminal` argument by
 * `runPipeline` call sites in `daemon/conversation-agent-loop.ts`. This
 * separation matters: the default plugin is registered before any user plugin
 * (defaults load first in `bootstrapPlugins()`), which puts it at the
 * OUTERMOST position of the onion chain. If the default middleware were to
 * invoke the terminal directly without calling `next`, it would shadow every
 * later-registered plugin. Routing through `next(args)` lets user middleware
 * participate normally.
 *
 * Plugins that override this middleware receive both `history` and `provider`
 * so they can route behavior per provider (e.g. strip blocks a specific
 * provider can't handle) without reaching into ambient state.
 */

import { type Plugin } from "../../types.js";
import historyRepair from "./middlewares/historyRepair.js";
import pkg from "./package.json" with { type: "json" };

export const defaultHistoryRepairPlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
  middleware: {
    historyRepair,
  },
};
