/**
 * Raw persistence for the single selected-assistant id.
 *
 * Deliberately dependency-free (only `@/utils/local-settings`) so it can be
 * imported by BOTH `resolved-assistants-store.ts` (the reactive owner) and
 * `lib/local-mode.ts` (the lockfile-resolving getters) without an import
 * cycle — the store already imports `local-mode`, so `local-mode` can't import
 * the store. `setLocalSetting` fires the same-tab `vellum:pref-changed` event,
 * so writes are observable cross-tab (native `storage`) and same-tab.
 *
 * The reactive `selectedAssistantId` slice in the store is the source of truth
 * consumers subscribe to; this module is the raw key access both sides agree on.
 */

import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/utils/local-settings";

export const SELECTED_ASSISTANT_STORAGE_KEY = "vellum:selectedAssistantId";

export function readSelectedAssistantId(): string | null {
  return getLocalSetting(SELECTED_ASSISTANT_STORAGE_KEY, "") || null;
}

export function writeSelectedAssistantId(id: string): void {
  setLocalSetting(SELECTED_ASSISTANT_STORAGE_KEY, id);
}

export function clearSelectedAssistantId(): void {
  removeLocalSetting(SELECTED_ASSISTANT_STORAGE_KEY);
}
