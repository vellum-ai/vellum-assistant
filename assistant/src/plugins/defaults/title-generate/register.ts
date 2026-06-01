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

import { type Plugin } from "../../types.js";
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
