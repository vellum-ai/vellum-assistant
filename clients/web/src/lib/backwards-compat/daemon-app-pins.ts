/**
 * Backwards-compat gate: where an app's pinned state is stored.
 *
 * A daemon advertising the `appPins` healthz capability owns pins. They ride on
 * the app list as `pinSortPosition` / `pinColor`, and `POST apps/:id/pin` sets
 * them, so a pin is scoped to the assistant that owns the app and follows the
 * user across browsers.
 *
 * Older daemons have neither the route nor the fields. There the web app keeps
 * its own list in the `vellum:pinnedApps` localStorage key, which is
 * browser-wide and shared by every assistant: pins from one assistant show up
 * under another (LUM-3452). That defect is the reason pinning moved, and it
 * cannot be fixed from the client, so the legacy path keeps the old behaviour
 * rather than pretending to fix it.
 *
 * A capability flag rather than a version floor, for the reason
 * `use-assistant-capability` gives: dev builds are cut hourly from `main`, so
 * any floor stamped before this lands is cleared by a build that does not carry
 * the route, and a floor stamped after it leaves dogfooders dark. The daemon
 * answering for itself has neither problem.
 *
 * Once every supported daemon advertises the capability, delete this module,
 * `utils/app-pin-storage.ts`, and `hooks/use-legacy-pin-migration.ts` along
 * with it, and read pins off the app list unconditionally.
 */

import { useAssistantCapability } from "@/hooks/use-assistant-capability";

/** Whether the connected daemon stores app pins. */
export function useSupportsDaemonAppPins(): boolean {
  return useAssistantCapability("appPins");
}
