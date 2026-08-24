/**
 * Backwards-compat gate: where an app's pinned state is stored.
 *
 * From this version the daemon owns pins. They ride on the app list as
 * `pinnedOrder` / `pinColor`, and `POST apps/:id/pin` sets them, so a pin is
 * scoped to the assistant that owns the app and follows the user across
 * browsers.
 *
 * Older daemons have neither the route nor the fields. There the web app keeps
 * its own list in the `vellum:pinnedApps` localStorage key, which is
 * browser-wide and shared by every assistant: pins from one assistant show up
 * under another (LUM-3452). That defect is the reason pinning moved, and it
 * cannot be fixed from the client, so the legacy path keeps the old behaviour
 * rather than pretending to fix it.
 *
 * Reads only, in both directions: a daemon without the route answers 404, and
 * a daemon without the fields reports every app unpinned, so an ungated client
 * would show an empty sidebar and refuse to pin.
 *
 * Once this floor is the minimum supported version, delete this module,
 * `utils/app-pin-storage.ts`, and `hooks/use-legacy-pin-migration.ts` along
 * with it, and read pins off the app list unconditionally.
 */

import { useAssistantSupports } from "@/lib/backwards-compat/utils";

/**
 * A dev floor rather than a predicted release, per the guidance in
 * `docs/BACKWARDS_COMPAT.md`: base versions compare first, so every later
 * release clears it, and dev builds cut from `main` after the daemon change
 * landed light up instead of waiting for the next tag.
 */
const MIN_VERSION = "0.11.5-dev.202608241840.50a7cca74a";

/** Whether the connected daemon stores app pins. */
export function useSupportsDaemonAppPins(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
