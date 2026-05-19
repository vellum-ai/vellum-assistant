import { getConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/schema.js";
import {
  seedSkillGraphNodes,
  seedUninstalledCatalogSkillMemories,
} from "../memory/graph/capability-seed.js";
import { getLogger } from "../util/logger.js";
import {
  maybeSeedMemoryV2CliCommands,
  maybeSeedMemoryV2Skills,
} from "./memory-v2-startup.js";

const log = getLogger("skill-memory-refresh");

export function refreshSkillCapabilityMemories(
  config: AssistantConfig = getConfig(),
): void {
  seedSkillGraphNodes();
  maybeSeedMemoryV2Skills(config);
  maybeSeedMemoryV2CliCommands(config);
  void seedUninstalledCatalogSkillMemories()
    .then(() => {
      // Re-run after the async catalog fetch populates the cache so stale
      // installed-skill nodes can be pruned without deleting catalog-only nodes.
      seedSkillGraphNodes();
    })
    .catch((err) =>
      log.warn(
        { err },
        "Uninstalled catalog skill memory seeding failed — continuing",
      ),
    );
}
