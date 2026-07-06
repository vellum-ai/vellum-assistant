import { useEffect } from "react";
import * as Sentry from "@sentry/react";

import { publish } from "@/lib/event-bus";
import { setNotificationTapHandler } from "@/runtime/notifications";

/**
 * Routes notification taps to the originating conversation. Mounted at
 * `RootLayout` so a tap arriving on any authenticated route navigates.
 *
 * The handler publishes `deeplink.openThread` on the event bus rather
 * than navigating directly — `useGlobalDeepLinkConsumer` (also mounted
 * at `RootLayout`) turns that into `ensureMainWindowVisible()` +
 * `navigate(routes.conversation(threadId))`, so notification taps get
 * identical behavior to `vellum://thread/...` deep links. One wiring
 * covers all three tap paths in `runtime/notifications.ts`: Capacitor
 * `localNotificationActionPerformed`, Electron notification actions,
 * and browser `Notification.onclick`.
 *
 * No effect cleanup: `setNotificationTapHandler` swaps the handler
 * reference in place and registers the platform listeners only once
 * for the app's lifetime, so there is nothing to tear down.
 */
export function useNotificationTapNavigation(): void {
  useEffect(() => {
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
