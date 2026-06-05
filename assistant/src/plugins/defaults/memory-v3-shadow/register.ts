/**
 * Default `memory-v3-shadow` plugin.
 *
 * Houses the memory-v3 shadow/live orchestration engine (this directory) and
 * its injector (`./injector.ts`). The injector is still consumed by the static
 * chain in `memory-retrieval/injector-chain.ts`; the `user-prompt-submit` /
 * `post-compact` hooks below are no-op scaffolding for the eventual
 * convergence, when v3 injection moves off the loop-driven chain and into these
 * lifecycle hooks. See each hook file for the convergence note.
 */

import { type Plugin } from "../../types.js";
import postCompact from "./hooks/post-compact.js";
import userPromptSubmit from "./hooks/user-prompt-submit.js";
import pkg from "./package.json" with { type: "json" };

export const memoryV3ShadowPlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
  hooks: {
    "user-prompt-submit": userPromptSubmit,
    "post-compact": postCompact,
  },
};
