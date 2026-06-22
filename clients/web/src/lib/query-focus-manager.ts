/**
 * Bridge the event bus's app-lifecycle signals into TanStack Query's
 * {@link focusManager} so **every** query automatically refetches when
 * the app returns to the foreground — including on Capacitor iOS where
 * `appStateChange` fires but `visibilitychange` does not.
 *
 * TQ's default FocusManager listens only to `document.visibilitychange`.
 * That covers web and Electron but misses Capacitor's
 * `App.appStateChange`. Rather than manually calling
 * `invalidateQueries` in each sync hook (fragile, incomplete, doubles
 * up with TQ's own refetch on web), we replace TQ's listener with one
 * that consumes the bus — the single source of truth for lifecycle
 * signals (see EVENT_BUS.md).
 *
 * The `"online"` resume signal is intentionally ignored here; network
 * reconnection is TQ's `onlineManager` concern, not focus.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/reference/focusManager
 * - EVENT_BUS.md — lifecycle signal taxonomy
 * - CAPACITOR.md — Capacitor iOS platform gaps
 */

import { focusManager } from "@tanstack/react-query";

import { subscribe } from "@/lib/event-bus";

/**
 * Configure TQ's global FocusManager to consume the event bus's
 * `app.resume` / `app.hidden` signals instead of raw DOM events.
 *
 * Call once at app init (inside the signal-source wiring effect in
 * `use-event-bus-init.ts`). Returns an unsubscribe function that
 * restores TQ's default listener.
 */
export function setupQueryFocusManager(): () => void {
  focusManager.setEventListener((handleFocus) => {
    const unsubResume = subscribe("app.resume", ({ signal }) => {
      if (signal === "online") return;
      handleFocus(true);
    });
    const unsubHidden = subscribe("app.hidden", () => {
      handleFocus(false);
    });
    return () => {
      unsubResume();
      unsubHidden();
    };
  });

  // Restore TQ's default listener on teardown by passing a no-op
  // setup that re-registers the standard visibilitychange handler.
  return () => {
    focusManager.setEventListener((handleFocus) => {
      const handler = () =>
        handleFocus(document.visibilityState === "visible");
      document.addEventListener("visibilitychange", handler);
      return () => document.removeEventListener("visibilitychange", handler);
    });
  };
}
