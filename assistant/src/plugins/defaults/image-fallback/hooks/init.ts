/**
 * Default `init` hook: opens the plugin-owned caption database
 * (`caption-cache.sqlite` in the plugin's storage dir) and ensures its
 * schema. Fail-open — if the store cannot be opened, captioning degrades to
 * in-memory-only caching and the plugin keeps working.
 */

import { type HookFunction, type InitContext } from "@vellumai/plugin-api";

import { initCaptionStore } from "../src/caption-cache.js";

const init: HookFunction<InitContext> = async (ctx) => {
  initCaptionStore(ctx.pluginStorageDir);
};

export default init;
