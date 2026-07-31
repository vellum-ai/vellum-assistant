/**
 * Where the Pinned section's user-chosen height persists, per assistant.
 *
 * Every section's row list caps at {@link SIDEBAR_SECTION_MAX_HEIGHT} and
 * scrolls within itself; dragging the rule under the curated block re-caps
 * Pinned alone, bounded to
 * [{@link SIDEBAR_SECTION_RESIZE_MIN_HEIGHT},
 * {@link SIDEBAR_SECTION_RESIZE_MAX_HEIGHT}]. Stored per assistant in
 * localStorage under the `user` scope, matching how the view mode, collapse
 * state, and section order persist.
 */

import {
  SIDEBAR_SECTION_MAX_HEIGHT,
  SIDEBAR_SECTION_RESIZE_MAX_HEIGHT,
  SIDEBAR_SECTION_RESIZE_MIN_HEIGHT,
} from "@/components/sidebar-nav-geometry";
import { createKeyedStorageAccessor } from "@/utils/typed-storage";

/** Round and bound a candidate height to the resize range. */
export function clampPinnedSectionHeight(height: number): number {
  return Math.min(
    SIDEBAR_SECTION_RESIZE_MAX_HEIGHT,
    Math.max(SIDEBAR_SECTION_RESIZE_MIN_HEIGHT, Math.round(height)),
  );
}

/**
 * Strict parse: junk falls back to the default, while a finite value outside
 * the current bounds clamps rather than resets, so a stored height keeps its
 * intent if the bounds ever tighten.
 */
function parsePinnedSectionHeight(raw: string): number | null {
  if (raw.trim() === "") {
    return null; // Number("") is 0, not a stored choice.
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return null;
  }
  return clampPinnedSectionHeight(value);
}

const pinnedHeightStorage = createKeyedStorageAccessor<number>({
  keyFn: (assistantId) => `vellum:sidebar-pinned-height:${assistantId}`,
  scope: "user",
  parse: parsePinnedSectionHeight,
  serialize: (height) => String(height),
  fallback: SIDEBAR_SECTION_MAX_HEIGHT,
});

/**
 * Subscribe to one assistant's Pinned section height.
 *
 * Storage is the source of truth: the first render already carries the
 * stored choice, and a height committed in one window reaches every other
 * window on the same assistant.
 */
export function usePinnedSectionHeight(assistantId: string): number {
  return pinnedHeightStorage.useValue(assistantId);
}

export function savePinnedSectionHeight(
  assistantId: string,
  height: number,
): void {
  pinnedHeightStorage.save(assistantId, clampPinnedSectionHeight(height));
}

/** Drop the stored height so the section returns to the shipped default. */
export function resetPinnedSectionHeight(assistantId: string): void {
  pinnedHeightStorage.remove(assistantId);
}
