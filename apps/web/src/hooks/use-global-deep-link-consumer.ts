import { useEffect, useRef } from "react";
import * as Sentry from "@sentry/react";
import { useNavigate } from "react-router";

import { subscribe } from "@/lib/event-bus";
import { ensureMainWindowVisible } from "@/runtime/main-window";
import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";
import { routes } from "@/utils/routes";

/**
 * Global deep-link consumer — mounted at `RootLayout` so it's alive
 * for every authenticated assistant route, not just `/assistant`
 * (`ChatPage`). Without it, a `vellum://thread/...` click while the
 * user is on `/assistant/settings` would be dropped.
 *
 * Responsibilities:
 *
 * - `deeplink.openThread` → `ensureMainWindowVisible()` +
 *   `navigate(routes.conversation(threadId))`.
 * - `deeplink.send` → `ensureMainWindowVisible()` + navigate to
 *   `/assistant` + park the message in `usePendingDeepLinkStore`
 *   for `ChatPage`'s composer-domain hook to consume on mount.
 * - `deeplink.unknown` → Sentry breadcrumb.
 *
 * The composer pre-fill itself stays in the chat domain
 * (`useDeepLinkConsumer`) because it owns `setInput`. This hook is
 * intentionally generic — it doesn't import chat-specific state.
 */

export function useGlobalDeepLinkConsumer(): void {
  const navigate = useNavigate();
  // Mirror dynamic deps in a ref so the effect mounts once. Without
  // this, a navigate-fn identity change would tear down + resubscribe
  // the bus listeners and open a race window where a link could
  // arrive between unsubscribe and resubscribe.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    const unsubSend = subscribe("deeplink.send", ({ message }) => {
      void ensureMainWindowVisible();
      usePendingDeepLinkStore.getState().setPendingComposerMessage(message);
      navigateRef.current(routes.assistant);
    });

    const unsubOpenThread = subscribe(
      "deeplink.openThread",
      ({ threadId }) => {
        void ensureMainWindowVisible();
        navigateRef.current(routes.conversation(threadId));
      },
    );

    const unsubUnknown = subscribe("deeplink.unknown", ({ url }) => {
      Sentry.addBreadcrumb({
        category: "deeplink",
        level: "info",
        message: "deeplink.unknown",
        data: { url },
      });
    });

    return () => {
      unsubSend();
      unsubOpenThread();
      unsubUnknown();
    };
  }, []);
}
