/**
 * Default `shutdown` hook: closes the plugin-owned caption database so a
 * daemon shutdown or an in-place plugin redeploy never leaks the handle.
 */

import { type HookFunction, type ShutdownContext } from "@vellumai/plugin-api";

import { closeCaptionStore } from "../src/caption-cache.js";

const shutdown: HookFunction<ShutdownContext> = async () => {
  closeCaptionStore();
};

export default shutdown;
