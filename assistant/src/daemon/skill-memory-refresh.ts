import { getConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/schema.js";
import {
  seedSkillGraphNodes,
  seedUninstalledCatalogSkillMemories,
} from "../plugins/defaults/memory/graph/capability-seed.js";
import {
  maybeSeedCapabilitySkills,
  maybeSeedCliCommandCards,
} from "../plugins/defaults/memory/substrate/boot-maintenance.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("skill-memory-refresh");

export function refreshSkillCapabilityMemories(
  config: AssistantConfig = getConfig(),
): void {
  seedSkillGraphNodes();
  maybeSeedCapabilitySkills(config);
  maybeSeedCliCommandCards(config);
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
