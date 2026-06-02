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

import { type Plugin } from "../../types.js";
import persistence from "./middlewares/persistence.js";
import pkg from "./package.json" with { type: "json" };

export const defaultPersistencePlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
  middleware: {
    persistence,
  },
};
