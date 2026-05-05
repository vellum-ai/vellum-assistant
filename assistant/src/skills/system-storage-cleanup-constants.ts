const BUNDLED_SKILL_SELECTOR_PREFIX = "bundled:";
export const SYSTEM_STORAGE_CLEANUP_SKILL_ID = "system-storage-cleanup";
export const BUNDLED_SYSTEM_STORAGE_CLEANUP_SELECTOR = `${BUNDLED_SKILL_SELECTOR_PREFIX}${SYSTEM_STORAGE_CLEANUP_SKILL_ID}`;

export function normalizeBundledSystemStorageCleanupSelector(
  selector: string,
): typeof BUNDLED_SYSTEM_STORAGE_CLEANUP_SELECTOR | null {
  const needle = selector.trim();
  if (!needle.startsWith(BUNDLED_SKILL_SELECTOR_PREFIX)) {
    return null;
  }

  const bundledSkillId = needle
    .slice(BUNDLED_SKILL_SELECTOR_PREFIX.length)
    .trim();
  if (bundledSkillId !== SYSTEM_STORAGE_CLEANUP_SKILL_ID) {
    return null;
  }

  return BUNDLED_SYSTEM_STORAGE_CLEANUP_SELECTOR;
}

export function isBundledSystemStorageCleanupSelector(
  selector: string,
): boolean {
  return (
    normalizeBundledSystemStorageCleanupSelector(selector) ===
    BUNDLED_SYSTEM_STORAGE_CLEANUP_SELECTOR
  );
}
