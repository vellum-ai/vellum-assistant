// Persist the sidebar conversation group expand/collapse state to localStorage
// so that the user's last-known toggle state for each collapsible group
// (Scheduled, Background, per-channel sections, and custom groups) survives
// page reloads.
//
// Primary sections (Pinned / Chats), built-in sections (scheduled / background
// / per-channel), and custom groups are stored under SEPARATE keys, chiefly
// because they have different defaults: primary sections default to OPEN, the
// other two to closed.
//
// Storage buckets are not accordion roots. Every section - Pinned, Chats, the
// channel sections, and the custom groups - renders in a *single*
// CollapsibleNavSection.Root, because the user can order them freely and a
// custom group may sit between two built-in sections. The sidebar splits that
// root's one value array back into these three buckets with
// `isKnownPrimaryKey` / `isKnownCategoryKey`; anything matching neither is a
// custom group id.

import { parseStringArray } from "@/domains/chat/utils/storage-validators";
import { createKeyedStorageAccessor } from "@/utils/typed-storage";

const OPEN_CATEGORY_KEYS = new Set(["scheduled", "background"]);

/**
 * The always-present primary sections (Pinned, Chats). Unlike the built-in
 * categories and custom groups, these default to OPEN.
 */
export const PRIMARY_SECTION_KEYS = ["pinned", "recents"] as const;

/**
 * True for the primary sections (Pinned, Chats). The sidebar renders primary
 * and category sections in a single accordion root so they share one uniform
 * gap, then splits the accordion's value array back into the two storage
 * buckets with this predicate.
 */
export function isKnownPrimaryKey(key: string): boolean {
  return (PRIMARY_SECTION_KEYS as readonly string[]).includes(key);
}

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

/** True for a per-origin-channel section key (e.g. `"channel:slack"`). */
export function isChannelSectionKey(key: string): boolean {
  return key.startsWith(CHANNEL_SECTION_PREFIX);
}

/**
 * True for the built-in collapsible categories (Scheduled, Background, and
 * every `channel:` section). Exported so the sidebar can route a key from the
 * shared accordion root into the right storage bucket: primary, category, or
 * - matching neither - a custom group id.
 */
export function isKnownCategoryKey(category: string): boolean {
  return OPEN_CATEGORY_KEYS.has(category) || isChannelSectionKey(category);
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

// Primary sections default to OPEN: the fallback returns both keys, so a
// first-time user (no stored key) sees Pinned + Chats expanded. A stored empty
// array is distinct — it means the user explicitly collapsed both — because
// createKeyedStorageAccessor only falls back when the key is absent.
const primaryStorage = createKeyedStorageAccessor<string[]>({
  keyFn: (assistantId) => `vellum:sidebar-open-primary:${assistantId}`,
  scope: "user",
  parse: parseStringArray,
  serialize: JSON.stringify,
  fallback: [...PRIMARY_SECTION_KEYS],
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

/** Load the open primary sections (Pinned, Chats). Defaults to both open. */
export function loadOpenPrimary(assistantId: string): string[] {
  return primaryStorage.load(assistantId).filter(isKnownPrimaryKey);
}

export function saveOpenPrimary(
  assistantId: string,
  openPrimary: string[],
): void {
  primaryStorage.save(assistantId, openPrimary);
}
