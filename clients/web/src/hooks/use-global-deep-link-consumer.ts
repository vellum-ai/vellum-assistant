import { useLayoutEffect, useRef } from "react";
import * as Sentry from "@sentry/react";
import { useNavigate } from "react-router";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
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
  const navigateRef = useRef(navigate);
  useLayoutEffect(() => {
    navigateRef.current = navigate;
  });

  useBusSubscription("deeplink.send", ({ message }) => {
    void ensureMainWindowVisible();
    usePendingDeepLinkStore.getState().setPendingComposerMessage(message);
    navigateRef.current(routes.assistant);
  });

  useBusSubscription("deeplink.openThread", ({ threadId }) => {
    void ensureMainWindowVisible();
    navigateRef.current(routes.conversation(threadId));
  });

  useBusSubscription("deeplink.unknown", ({ url }) => {
    Sentry.addBreadcrumb({
      category: "deeplink",
      level: "info",
      message: "deeplink.unknown",
      data: { url },
    });
  });
}
