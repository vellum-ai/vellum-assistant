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
import { readWorkspaceSkillMdSignature } from "../skills/workspace-skill-md-signature.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("skill-memory-refresh");

/** Poll interval for workspace `SKILL.md` mtimes. Stats only, no tree walk. */
export const SKILL_MD_MTIME_POLL_MS = 1_500;

let lastSignature: string | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;

export function refreshSkillCapabilityMemories(
  config: AssistantConfig = getConfig(),
): void {
  seedSkillGraphNodes();
  maybeSeedCapabilitySkills(config);
  maybeSeedCliCommandCards(config);
  lastSignature = readWorkspaceSkillMdSignature();
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

/**
 * Reseed skill capability memories when the workspace `SKILL.md` set or
 * mtimes have changed since the last refresh in this process. No-op when the
 * signature is unchanged. First call in a process always reseeds so the
 * memory worker, whose in-process skill cache starts empty, picks up the
 * catalog without waiting for an install path.
 */
export function maybeRefreshSkillCapabilityMemoriesFromMtime(): boolean {
  const signature = readWorkspaceSkillMdSignature();
  if (lastSignature !== undefined && signature === lastSignature) {
    return false;
  }
  if (lastSignature !== undefined) {
    log.info("Workspace SKILL.md set changed, reseeding capability memories");
  }
  refreshSkillCapabilityMemories();
  return true;
}

function pollOnce(): void {
  try {
    maybeRefreshSkillCapabilityMemoriesFromMtime();
  } catch (err) {
    log.warn({ err }, "SKILL.md mtime poll failed");
  }
}

/**
 * Start a per-process poll of workspace `SKILL.md` mtimes. Idempotent.
 * The memory worker and the assistant each run this against their own
 * in-process skill caches. Runs once immediately so a worker that has never
 * seeded picks up the catalog without waiting a tick.
 */
export function startWorkspaceSkillMdMtimePoll(): void {
  if (pollTimer !== undefined) {
    return;
  }
  pollOnce();
  pollTimer = setInterval(pollOnce, SKILL_MD_MTIME_POLL_MS);
  pollTimer.unref?.();
}

export function stopWorkspaceSkillMdMtimePoll(): void {
  if (pollTimer === undefined) {
    return;
  }
  clearInterval(pollTimer);
  pollTimer = undefined;
}

/** @internal Test-only: clear the in-process signature and poll timer. */
export function _resetSkillMdMtimeStateForTests(): void {
  lastSignature = undefined;
  stopWorkspaceSkillMdMtimePoll();
}
