/**
 * Memory plugin `init` hook — own the memory subsystem's boot end-to-end:
 * register its job handlers, kick off background startup (which starts the jobs
 * worker), and start the periodic PKB filing/compaction service.
 *
 * The plugin registers its own handlers directly into the worker dispatch table
 * (rather than through a generic plugin registry) synchronously here, before
 * `runMemoryStartup` is kicked off — so registration is guaranteed to
 * happen-before the worker's first job claim (the worker is started near the end
 * of `runMemoryStartup`, after Qdrant is up). `runMemoryStartup` runs
 * fire-and-forget so the daemon keeps serving while memory warms up; each of its
 * steps contains its own failure. The filing service is skipped under memory v2,
 * whose consolidation job owns periodic background memory processing.
 */

import type { HookFunction, InitContext } from "@vellumai/plugin-api";

import { getConfig } from "../../../../config/loader.js";
import { getLogger } from "../../../../util/logger.js";
import { getMemoryConfig } from "../config.js";
import { FilingService } from "../filing-service.js";
import { registerMemoryPluginJobHandlers } from "../job-handler-registration.js";
import { runMemoryStartup } from "../startup.js";

const log = getLogger("memory-init");

const init: HookFunction<InitContext> = async () => {
  // Register the memory plugin's own job handlers directly into the worker
  // dispatch table. Synchronous and first, so it happens-before the worker start
  // inside `runMemoryStartup` below — otherwise a queued job could be dispatched
  // against an empty table and failed as an unknown type. The daemon's
  // non-plugin domain handlers are already registered before plugin bootstrap;
  // the standalone worker process self-registers both sets itself.
  registerMemoryPluginJobHandlers();

  // Boot Qdrant, reconcile collections, and start the memory jobs worker in the
  // background so the daemon keeps accepting requests without waiting on it.
  // Fire-and-forget with a contained failure — a memory-subsystem problem must
  // never block boot.
  void runMemoryStartup(getConfig()).catch((err) =>
    log.warn({ err }, "Background memory startup failed"),
  );

  if (getMemoryConfig().v2.enabled) {
    log.info(
      "Filing service skipped — memory v2 consolidation is the active background memory job",
    );
    return;
  }
  new FilingService().start();
};

export default init;
