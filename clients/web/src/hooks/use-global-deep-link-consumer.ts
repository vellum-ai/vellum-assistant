import { useLayoutEffect, useRef } from "react";
import * as Sentry from "@sentry/react";
import { useNavigate } from "react-router";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { ensureMainWindowVisible } from "@/runtime/main-window";
import { useConversationStore } from "@/stores/conversation-store";
import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";
import { useViewerStore } from "@/stores/viewer-store";
import { navigateToConversation } from "@/utils/conversation-navigation";
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
 *   `navigateToConversation()`
 * - `deeplink.send` → `ensureMainWindowVisible()` + navigate to
 *   `/assistant` + park the message in `usePendingDeepLinkStore`
 *   for `ChatPage`'s composer-domain hook to consume on mount.
 * - `deeplink.billingCheckoutComplete` → `ensureMainWindowVisible()`
 *   + navigate to billing carrying the Stripe `session_id` (which
 *   opens the Pro onboarding wizard), or to the upgrade-cancel page
 *   on `status: "cancel"` — the same landing the web flow uses.
 * - `deeplink.unknown` → Sentry breadcrumb.
 *
 * The composer pre-fill itself stays in the chat domain
 * (`useDeepLinkConsumer`) because it owns `setInput`. This hook stays
 * generic — chat-specific store handling lives in the shared
 * `navigateToConversation` util.
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
    // Same thread: skip store resets — the id doesn't change, so re-seed effects wouldn't re-run and live cards would vanish.
    if (threadId === useConversationStore.getState().activeConversationId) {
      useViewerStore.getState().setMainView("chat");
      navigateRef.current(routes.conversation(threadId));
      return;
    }
    navigateToConversation(navigateRef.current, threadId);
  });

  useBusSubscription(
    "deeplink.billingCheckoutComplete",
    ({ status, sessionId }) => {
      void ensureMainWindowVisible();
      navigateRef.current(
        status === "success"
          ? routes.settings.usageBillingCheckout(sessionId)
          : routes.settings.upgradeCancel,
      );
    },
  );

  useBusSubscription("deeplink.unknown", ({ url }) => {
    Sentry.addBreadcrumb({
      category: "deeplink",
      level: "info",
      message: "deeplink.unknown",
      data: { url },
    });
  });
}
