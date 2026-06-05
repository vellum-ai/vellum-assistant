/**
 * Default `compaction` plugin.
 *
 * Compaction is implemented in `./compact.ts` as {@link defaultCompact}, which
 * the agent loop calls directly with a {@link CompactionContext}. The plugin
 * stays registered as a placeholder so it keeps a presence in the defaults
 * list while we decide how plugins should surface compaction; it contributes
 * no contract slot today.
 */

import { type Plugin } from "../../types.js";
import pkg from "./package.json" with { type: "json" };

/**
 * Manifest for the default compaction plugin. The registration happens in
 * `daemon/external-plugins-bootstrap.ts` before {@link bootstrapPlugins} fires
 * plugin `init()` hooks.
 */
export const defaultCompactionPlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
};
