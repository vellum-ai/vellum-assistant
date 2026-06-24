// Persist the sidebar conversation group expand/collapse state to localStorage
// so that the user's last-known toggle state for each collapsible group
// (Scheduled, Background, per-channel sections, and custom groups) survives
// page reloads.
//
// Built-in sections (scheduled / background / per-channel) and custom groups
// are stored under SEPARATE keys so each CollapsibleNavSection.Root manages only
// its own items — sharing a single array across two Radix roots would cause one
// root's onValueChange to clobber the other.

import { parseStringArray } from "@/domains/chat/utils/storage-validators";
import { createKeyedStorageAccessor } from "@/utils/typed-storage";

const OPEN_CATEGORY_KEYS = new Set([
  "scheduled",
  "background",
]);

/** Prefix marking a collapsible category as a per-channel origin section. */
const CHANNEL_SECTION_PREFIX = "channel:";

/**
 * Collapse-state key for an origin channel's sidebar section (e.g.
 * `"telegram"` → `"channel:telegram"`). Prefixed so {@link loadOpenCategories}
 * can accept any channel without an exhaustive allowlist while still dropping
 * unrecognized stale keys.
 */
export function channelSectionKey(channelId: string): string {
  return `${CHANNEL_SECTION_PREFIX}${channelId}`;
}

function isKnownCategoryKey(category: string): boolean {
  return (
    OPEN_CATEGORY_KEYS.has(category) ||
    category.startsWith(CHANNEL_SECTION_PREFIX)
  );
}

const categoriesStorage = createKeyedStorageAccessor<string[]>({
  keyFn: (assistantId) => `vellum:sidebar-open-categories:${assistantId}`,
  scope: "user",
  parse: parseStringArray,
  serialize: JSON.stringify,
  fallback: [],
});

const customGroupsStorage = createKeyedStorageAccessor<string[]>({
  keyFn: (assistantId) => `vellum:sidebar-open-custom-groups:${assistantId}`,
  scope: "user",
  parse: parseStringArray,
  serialize: JSON.stringify,
  fallback: [],
});

/** Load open built-in sidebar category keys, filtering stale values. */
export function loadOpenCategories(assistantId: string): string[] {
  return categoriesStorage.load(assistantId).filter(isKnownCategoryKey);
}

export function saveOpenCategories(
  assistantId: string,
  openCategories: string[],
): void {
  categoriesStorage.save(assistantId, openCategories);
}

export function loadOpenCustomGroups(assistantId: string): string[] {
  return customGroupsStorage.load(assistantId);
}

export function saveOpenCustomGroups(
  assistantId: string,
  openGroups: string[],
): void {
  customGroupsStorage.save(assistantId, openGroups);
}
