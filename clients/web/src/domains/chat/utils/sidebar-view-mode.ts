/**
 * The sidebar's two conversation-list views, and where the user's choice for
 * each assistant is persisted.
 *
 * - `all` (the default) - one flat, recency-sorted list of every conversation
 *   that is neither pinned nor filed in a custom group. Pinned and the custom
 *   groups render above it; nothing is bucketed by origin channel.
 * - `grouped` - conversations sort into one collapsible section per origin
 *   channel (Slack, Telegram, …), below Pinned, the custom groups, and Chats.
 *
 * Stored per assistant in localStorage under the `user` scope, matching how
 * the collapse state and section order persist.
 */

import { createKeyedStorageAccessor } from "@/utils/typed-storage";

export const SIDEBAR_VIEW_MODES = ["all", "grouped"] as const;

export type SidebarViewMode = (typeof SIDEBAR_VIEW_MODES)[number];

export const DEFAULT_SIDEBAR_VIEW_MODE: SidebarViewMode = "all";

/** Strict parse: anything that isn't a known mode falls back to the default. */
function parseViewMode(raw: string): SidebarViewMode | null {
  return SIDEBAR_VIEW_MODES.find((mode) => mode === raw) ?? null;
}

const viewModeStorage = createKeyedStorageAccessor<SidebarViewMode>({
  keyFn: (assistantId) => `vellum:sidebar-view-mode:${assistantId}`,
  scope: "user",
  parse: parseViewMode,
  serialize: (mode) => mode,
  fallback: DEFAULT_SIDEBAR_VIEW_MODE,
});

export function loadViewMode(assistantId: string): SidebarViewMode {
  return viewModeStorage.load(assistantId);
}

/**
 * Subscribe to one assistant's view mode.
 *
 * Storage is the source of truth rather than a value snapshotted into a store
 * on mount, which buys two things: the first paint already carries the user's
 * choice (no flash of the default while an effect catches up), and a change
 * made in one window reaches every other window on the same assistant,
 * because `saveViewMode` notifies both same-tab and cross-tab listeners.
 */
export function useViewMode(assistantId: string): SidebarViewMode {
  return viewModeStorage.useValue(assistantId);
}

export function saveViewMode(
  assistantId: string,
  mode: SidebarViewMode,
): void {
  viewModeStorage.save(assistantId, mode);
}
