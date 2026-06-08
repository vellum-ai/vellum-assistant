import { useEffect } from "react";
import * as Sentry from "@sentry/react";

import { useComposerStore } from "@/domains/chat/composer-store";
import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";

/**
 * Chat-domain half of the deep-link consumer pair. Reads the pending
 * `deeplink.send` message parked in `usePendingDeepLinkStore` by the
 * global consumer (`useGlobalDeepLinkConsumer`, mounted at
 * `RootLayout`) and applies it to the composer.
 *
 * Split exists because the global consumer must be route-stable
 * (deep links arrive whenever, not just on `/assistant`), but only
 * the chat domain knows about `setInput`. The store is the
 * narrow-waist hand-off.
 *
 * Semantics:
 *
 * - If the composer is empty (`.trim().length === 0`), consume the
 *   pending message and `setComposerInput(message)`.
 * - If non-empty, drop with a Sentry breadcrumb — refusing to
 *   overwrite the user's in-progress typing is the conservative
 *   call until we have telemetry to justify a "queue or prompt" UX.
 * - Runs on every render where `pendingComposerMessage` is non-null,
 *   so a deep link arriving WHILE `ChatPage` is already mounted is
 *   picked up on the next render. The Zustand selector re-renders
 *   the component when the slice changes.
 */

export function useDeepLinkConsumer(): void {
  const pending = usePendingDeepLinkStore.use.pendingComposerMessage();
  const input = useComposerStore.use.input();

  useEffect(() => {
    if (pending === null) return;
    const consumed = usePendingDeepLinkStore
      .getState()
      .consumePendingComposerMessage();
    if (consumed === null) return;
    if (input.trim().length > 0) {
      Sentry.addBreadcrumb({
        category: "deeplink",
        level: "info",
        message:
          "deeplink.send arrived but composer had unsaved text — drop, do not overwrite",
      });
      return;
    }
    useComposerStore.getState().setInput(consumed);
  }, [pending, input]);
}
