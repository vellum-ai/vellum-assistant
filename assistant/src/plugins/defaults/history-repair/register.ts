/**
 * Default `history-repair` plugin.
 *
 * Contributes a `user-prompt-submit` hook that normalizes the working message
 * history (tool-use/tool-result pairing, role alternation) before the agent
 * loop hands it to the provider. The repair implementation lives in
 * `./terminal.ts`; the hook in `./hooks/user-prompt-submit.ts` wires it into
 * the lifecycle. Defaults register before user plugins, so this normalization
 * runs at the front of the hook chain.
 */

import { type Plugin } from "../../types.js";
import userPromptSubmit from "./hooks/user-prompt-submit.js";
import pkg from "./package.json" with { type: "json" };

export const defaultHistoryRepairPlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
  hooks: {
    "user-prompt-submit": userPromptSubmit,
  },
};
