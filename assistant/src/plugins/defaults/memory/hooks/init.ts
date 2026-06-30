/**
 * Memory plugin `init` hook — start the periodic PKB filing/compaction service.
 *
 * Skipped under memory v2, whose consolidation job owns periodic background
 * memory processing; running filing alongside it would be redundant.
 */

import type { HookFunction, InitContext } from "@vellumai/plugin-api";

import { getConfig } from "../../../../config/loader.js";
import { getLogger } from "../../../../util/logger.js";
import { FilingService } from "../filing-service.js";

const log = getLogger("filing-service");

const init: HookFunction<InitContext> = async () => {
  if (getConfig().memory.v2.enabled) {
    log.info(
      "Filing service skipped — memory v2 consolidation is the active background memory job",
    );
    return;
  }
  new FilingService().start();
};

export default init;
