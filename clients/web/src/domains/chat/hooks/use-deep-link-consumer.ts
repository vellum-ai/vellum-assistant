import { useEffect } from "react";
import * as Sentry from "@sentry/react";

import { useComposerStore } from "@/domains/chat/composer-store";
import { useConversationStore } from "@/stores/conversation-store";
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
 * - If the composer is empty, or holds a draft that was just *restored* on
 *   cold load (not typed), consume the pending message and set it. A deeplink
 *   is an explicit user action, so it wins over a restored draft — otherwise an
 *   incoming link would silently no-op behind leftover draft text.
 * - If the composer holds genuine in-progress typing, drop with a Sentry
 *   breadcrumb — refusing to overwrite is the conservative call until we have
 *   telemetry to justify a "queue or prompt" UX.
 * - Fires when `pendingComposerMessage` becomes non-null — the Zustand
 *   atomic selector re-renders this hook's host when that slice changes, so a
 *   deep link arriving WHILE `ChatPage` is already mounted is still picked up.
 *   It deliberately does NOT subscribe to the composer draft (that would
 *   re-render the host on every keystroke); the checks read `getState()`.
 *
 * The restored-draft carve-out matters because `useDraftPersistence`'s cold-load
 * restore is registered ahead of this hook in `ActiveChatView`, so the draft can
 * already be in the store by the time this effect runs.
 */

export function useDeepLinkConsumer(): void {
  const pending = usePendingDeepLinkStore.use.pendingComposerMessage();

  useEffect(() => {
    if (pending === null) return;
    const consumed = usePendingDeepLinkStore
      .getState()
      .consumePendingComposerMessage();
    if (consumed === null) return;
    // Read imperatively — a one-shot decision when a link arrives, not something
    // to re-run per keystroke, so this hook must not subscribe to the draft.
    const { input, restoredDraftConversationId, setInput, clearRestoredDraftNotice } =
      useComposerStore.getState();
    const activeConversationId =
      useConversationStore.getState().activeConversationId;
    // A just-restored draft (cold load) is not live typing, so a deeplink may
    // replace it; only genuine typed text blocks the prefill.
    const inputIsRestoredDraft =
      restoredDraftConversationId !== null &&
      restoredDraftConversationId === activeConversationId;
    if (input.trim().length > 0 && !inputIsRestoredDraft) {
      Sentry.addBreadcrumb({
        category: "deeplink",
        level: "info",
        message:
          "deeplink.send arrived but composer had unsaved text — drop, do not overwrite",
      });
      return;
    }
    setInput(consumed);
    // The deeplink supersedes the restored draft, so retire its notice too.
    if (inputIsRestoredDraft) clearRestoredDraftNotice();
  }, [pending]);
}
