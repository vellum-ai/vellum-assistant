/**
 * Memory plugin `shutdown` hook — stop the periodic PKB filing/compaction
 * service, draining any in-flight run before the daemon exits.
 */

import type { HookFunction, ShutdownContext } from "@vellumai/plugin-api";

import { FilingService } from "../filing-service.js";

const shutdown: HookFunction<ShutdownContext> = async () => {
  await FilingService.getInstance()?.stop();
};

export default shutdown;
