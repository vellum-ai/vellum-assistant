/**
 * Default `emptyResponse` plugin.
 *
 * The plugin's middleware is a passthrough — it calls `next(args)` and returns
 * the result unchanged. The actual decision lives in the terminal handler in
 * `./terminal.ts`, which is wired in as the pipeline's `terminal` argument by
 * the `runPipeline` call site in `agent/loop.ts`. This separation matters: the
 * default plugin is registered before any user plugin (defaults load first in
 * `bootstrapPlugins()`), which puts it at the OUTERMOST position of the onion
 * chain. If the default middleware were to decide directly without calling
 * `next`, it would shadow every later-registered plugin. Routing through
 * `next(args)` lets user middleware participate normally.
 */

import { type Plugin } from "../../types.js";
import emptyResponse from "./middlewares/emptyResponse.js";
import pkg from "./package.json" with { type: "json" };

/** Singleton plugin — the registry rejects duplicate registrations by name. */
export const defaultEmptyResponsePlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
  middleware: {
    emptyResponse,
  },
};
