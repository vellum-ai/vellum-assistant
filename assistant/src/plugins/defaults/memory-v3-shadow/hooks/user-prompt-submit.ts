/**
 * No-op `user-prompt-submit` scaffolding for the memory-v3-shadow plugin.
 *
 * The v3 injector currently runs through the static injector chain
 * (`memory-retrieval/injector-chain.ts`), not through this hook. Once the
 * prompt-submit hook API stabilizes we will import `memoryV3Injector` from
 * `../injector.js` and run it here, so v3 injection is owned by the plugin's
 * own lifecycle rather than the loop-driven chain. Until then this hook
 * intentionally does nothing.
 */

import type {
  PluginHookFn,
  UserPromptSubmitContext,
} from "@vellumai/plugin-api";

const userPromptSubmit: PluginHookFn<UserPromptSubmitContext> = async () => {};

export default userPromptSubmit;
