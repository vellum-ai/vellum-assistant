/**
 * Default `init` hook: opens the plugin-owned database
 * (`caption-cache.sqlite` in the plugin's storage dir) and ensures the schema
 * for both of its tables — the caption cache and the per-conversation image
 * index the `image_ask` tool resolves filenames through. Fail-open — if the
 * store cannot be opened, captioning degrades to in-memory-only caching, the
 * index reads empty, and the plugin keeps working.
 */

import { type HookFunction, type InitContext } from "@vellumai/plugin-api";

import { initCaptionStore } from "../src/caption-cache.js";
import { initImageIndex } from "../src/image-index.js";

const init: HookFunction<InitContext> = async (ctx) => {
  initCaptionStore(ctx.pluginStorageDir);
  initImageIndex();
};

export default init;
