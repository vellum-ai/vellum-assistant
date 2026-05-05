export const BUNDLED_SKILL_SELECTOR_PREFIX = "bundled:";
export const SYSTEM_STORAGE_CLEANUP_SKILL_ID = "system-storage-cleanup";
export const BUNDLED_SYSTEM_STORAGE_CLEANUP_SELECTOR = `${BUNDLED_SKILL_SELECTOR_PREFIX}${SYSTEM_STORAGE_CLEANUP_SKILL_ID}`;

export function normalizeBundledSkillSelector(selector: string): string | null {
  const needle = selector.trim();
  if (!needle.startsWith(BUNDLED_SKILL_SELECTOR_PREFIX)) {
    return null;
  }

  const bundledSkillId = needle
    .slice(BUNDLED_SKILL_SELECTOR_PREFIX.length)
    .trim();
  if (!bundledSkillId) {
    return null;
  }

  return `${BUNDLED_SKILL_SELECTOR_PREFIX}${bundledSkillId}`;
}

export function isBundledSystemStorageCleanupSelector(
  selector: string,
): boolean {
  return (
    normalizeBundledSkillSelector(selector) ===
    BUNDLED_SYSTEM_STORAGE_CLEANUP_SELECTOR
  );
}
