/**
 * Memory plugin `init` hook — boot the memory subsystem in the background and
 * start the periodic PKB filing/compaction service.
 *
 * `runMemoryStartup` (Qdrant, collection reconciles, memory jobs worker) is
 * kicked off fire-and-forget so the daemon keeps serving while memory warms up;
 * each of its steps contains its own failure. The filing service is skipped
 * under memory v2, whose consolidation job owns periodic background memory
 * processing.
 */

import type { HookFunction, InitContext } from "@vellumai/plugin-api";

import { getConfig } from "../../../../config/loader.js";
import { getLogger } from "../../../../util/logger.js";
import { getMemoryConfig } from "../config.js";
import { FilingService } from "../filing-service.js";
import { runMemoryStartup } from "../startup.js";

const log = getLogger("memory-init");

const init: HookFunction<InitContext> = async () => {
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
