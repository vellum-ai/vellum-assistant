/**
 * Default `memory-retrieval` plugin.
 *
 * Contributes the `user-prompt-submit-temp` hook
 * (`./hooks/user-prompt-submit-temp.ts`), which performs the three retrievals
 * the agent loop needs before assembling a turn's runtime-injection block —
 * PKB context, the NOW.md scratchpad, and the gated memory-graph call — and
 * owns the retrieval's side effects (injected-block metadata, recall log,
 * `memory_recalled` event).
 *
 * Registered via {@link registerDefaultPlugins} (see `../index.ts`) so it is
 * present in the registry by the time {@link bootstrapPlugins} runs.
 */

import { type Plugin } from "../../types.js";
import userPromptSubmitTemp from "./hooks/user-prompt-submit-temp.js";
import pkg from "./package.json" with { type: "json" };

export const defaultMemoryRetrievalPlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
  hooks: {
    "user-prompt-submit-temp": userPromptSubmitTemp,
  },
};
