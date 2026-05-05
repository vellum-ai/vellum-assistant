import type { ActiveSkillEntry } from "./active-skill-tools.js";
import {
  BUNDLED_SYSTEM_STORAGE_CLEANUP_SELECTOR,
  SYSTEM_STORAGE_CLEANUP_SKILL_ID,
} from "./system-storage-cleanup-constants.js";

export function mergeActiveSkillEntry(
  entries: ActiveSkillEntry[],
  seenIds: Set<string>,
  entry: ActiveSkillEntry,
): boolean {
  if (!seenIds.has(entry.id)) {
    seenIds.add(entry.id);
    entries.push(entry);
    return true;
  }

  if (
    entry.id === SYSTEM_STORAGE_CLEANUP_SKILL_ID &&
    entry.selector === BUNDLED_SYSTEM_STORAGE_CLEANUP_SELECTOR
  ) {
    const existing = entries.find(
      (candidate) => candidate.id === SYSTEM_STORAGE_CLEANUP_SKILL_ID,
    );
    if (existing?.selector !== BUNDLED_SYSTEM_STORAGE_CLEANUP_SELECTOR) {
      if (existing) {
        existing.selector = BUNDLED_SYSTEM_STORAGE_CLEANUP_SELECTOR;
        if (entry.version) {
          existing.version = entry.version;
        }
      }
      return true;
    }
  }

  return false;
}
