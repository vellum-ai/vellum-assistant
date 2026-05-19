// Persist the sidebar conversation group expand/collapse state to localStorage
// so that the user's last-known toggle state for each group (Pinned, Scheduled,
// Background, Recents, and custom groups) survives page reloads.
//
// Shape on disk: string[] — the list of currently-open category keys, one entry
// per expanded group. The format mirrors the Radix Accordion `value` prop for
// `type="multiple"`. Defaults to ["recents"] when no stored state exists so the
// common case needs zero clicks after a fresh install.
//
// Built-in sections (pinned / scheduled / background / recents) and custom
// groups are stored under SEPARATE keys so each CollapsibleNavSection.Root
// manages only its own items — sharing a single array across two Radix roots
// would cause one root's onValueChange to clobber the other.

const STORAGE_KEY_PREFIX = "vellum:sidebar-open-categories:";
const STORAGE_KEY_PREFIX_CUSTOM = "vellum:sidebar-open-custom-groups:";
const DEFAULT_OPEN_CATEGORIES: string[] = ["recents"];
const DEFAULT_OPEN_CUSTOM_GROUPS: string[] = [];

function storageKey(assistantId: string): string {
  return `${STORAGE_KEY_PREFIX}${assistantId}`;
}

function storageKeyCustom(assistantId: string): string {
  return `${STORAGE_KEY_PREFIX_CUSTOM}${assistantId}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function readFromStorage(key: string, defaultValue: string[]): string[] {
  if (typeof window === "undefined") {
    return defaultValue;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return defaultValue;
    }
    const parsed: unknown = JSON.parse(raw);
    if (isStringArray(parsed)) {
      return parsed;
    }
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

function writeToStorage(key: string, value: string[]): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can fail in private browsing / quota-exceeded cases. Silently
    // drop; the in-memory selection still works for the current session.
  }
}

/**
 * Load the list of open built-in sidebar category keys for a given assistant.
 * Returns `["recents"]` when no stored state exists or on any parse error.
 */
export function loadOpenCategories(assistantId: string): string[] {
  return readFromStorage(storageKey(assistantId), DEFAULT_OPEN_CATEGORIES);
}

/**
 * Persist the list of open built-in sidebar category keys for a given assistant.
 */
export function saveOpenCategories(
  assistantId: string,
  openCategories: string[],
): void {
  writeToStorage(storageKey(assistantId), openCategories);
}

/**
 * Load the list of open custom group IDs for a given assistant.
 * Returns `[]` when no stored state exists or on any parse error.
 */
export function loadOpenCustomGroups(assistantId: string): string[] {
  return readFromStorage(storageKeyCustom(assistantId), DEFAULT_OPEN_CUSTOM_GROUPS);
}

/**
 * Persist the list of open custom group IDs for a given assistant.
 */
export function saveOpenCustomGroups(
  assistantId: string,
  openGroups: string[],
): void {
  writeToStorage(storageKeyCustom(assistantId), openGroups);
}