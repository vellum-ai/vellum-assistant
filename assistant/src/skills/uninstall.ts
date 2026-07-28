import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { deleteSkillCapabilityNode } from "../plugins/defaults/memory/graph/capability-seed.js";
import { getWorkspaceSkillsDir } from "../util/platform.js";

/**
 * Remove a locally-installed skill: delete its workspace directory and prune
 * its capability graph node. Throws if the skill is not installed.
 *
 * Kept out of `catalog-install` so the install path (reachable from
 * `skills/load`) does not import `capability-seed` — and through it the CLI
 * program — for a dependency only uninstall needs.
 */
export function uninstallSkillLocally(skillId: string): void {
  const skillDir = join(getWorkspaceSkillsDir(), skillId);

  if (!existsSync(skillDir)) {
    throw new Error(`Skill "${skillId}" is not installed.`);
  }

  rmSync(skillDir, { recursive: true, force: true });
  deleteSkillCapabilityNode(skillId);
}
