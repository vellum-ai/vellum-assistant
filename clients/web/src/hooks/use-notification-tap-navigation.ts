import { useEffect } from "react";
import * as Sentry from "@sentry/react";

import { publish } from "@/lib/event-bus";
import { setNotificationTapHandler } from "@/runtime/notifications";

/**
 * Routes notification taps to the originating conversation. Mounted at
 * `RootLayout` so a tap arriving on any authenticated route navigates.
 *
 * Publishes `deeplink.openThread` rather than navigating directly so
 * taps share the `vellum://thread/...` deep-link path; one wiring
 * covers all three tap paths in `runtime/notifications.ts`.
 *
 * No effect cleanup: `setNotificationTapHandler` swaps the handler
 * reference in place and registers the platform listeners only once
 * for the app's lifetime, so there is nothing to tear down.
 */
export function useNotificationTapNavigation(): void {
  useEffect(() => {
    // Electron pop-out windows (`?popout=1`) mount `RootLayout` too, and
    // the macOS notification bridge broadcasts each action to every
    // BrowserWindow. Only the main window may handle taps — a pop-out
    // navigating would replace the conversation it exists to keep open.
    if (window.location.search.includes("popout=1")) {
      return;
    }
    setNotificationTapHandler((payload) => {
      if (payload.conversationId) {
        publish("deeplink.openThread", { threadId: payload.conversationId });
        return;
      }
      Sentry.addBreadcrumb({
        category: "notification",
        level: "info",
        message: "tap_without_conversation",
        data: { sourceEventName: payload.sourceEventName },
      });
    });
  }, []);
}
