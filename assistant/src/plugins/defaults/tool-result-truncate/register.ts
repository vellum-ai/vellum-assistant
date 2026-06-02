/**
 * Default `tool-result-truncate` plugin.
 *
 * Contributes a `post-tool-use` hook that tail-drops an oversized tool result
 * down to a character budget derived from the model's context window before
 * the result is sent to the provider. The truncation implementation lives in
 * `./terminal.ts`; the hook in `./hooks/post-tool-use.ts` wires it into the
 * lifecycle. Defaults register before user plugins, so this runs at the front
 * of the hook chain.
 */

import { type Plugin } from "../../types.js";
import postToolUse from "./hooks/post-tool-use.js";
import pkg from "./package.json" with { type: "json" };

export const defaultToolResultTruncatePlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
  hooks: {
    "post-tool-use": postToolUse,
  },
};
