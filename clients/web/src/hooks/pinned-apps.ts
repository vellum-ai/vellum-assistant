/**
 * The shape both pin backends satisfy, and the view a pinned row renders from.
 *
 * Separate from `use-pinned-apps.ts` so the daemon and legacy implementations
 * can each import it without importing each other.
 */

import type { AppSummary } from "@/types/app-types";

/**
 * What a pinned row renders from. Narrower than the full {@link AppSummary}
 * because the legacy backend can supply only these four fields, and because a
 * sidebar row has no use for an app's provenance or timestamps.
 */
export type PinnedAppView = Pick<
  AppSummary,
  "id" | "name" | "icon" | "pinColor"
>;

/**
 * One way of storing pins. Actions are no-ops for an app that is not pinned,
 * so a colour can never conjure a pin that unpinning just removed.
 */
export interface PinnedAppsBackend {
  /** Pinned apps in sidebar order. */
  pinnedApps: PinnedAppView[];
  togglePin: (appId: string) => void;
  unpin: (appId: string) => void;
  /**
   * Set or clear the colour the sidebar tints this pin with, as an id from the
   * pinned-app colour registry. `null` clears it.
   */
  setColor: (appId: string, color: string | null) => void;
}
