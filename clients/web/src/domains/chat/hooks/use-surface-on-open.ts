import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { surfaceConversation } from "@/domains/chat/api/conversations";
import { captureError } from "@/lib/sentry/capture-error";
import type { AssistantState } from "@/assistant/types";
import type { Conversation } from "@/types/conversation-types";
import {
  applySurfacedConversation,
  shouldSurfaceConversation,
} from "@/utils/conversation-cache-mutations";

/**
 * Surfaces the active conversation when the user opens an unsurfaced
 * background or scheduled run.
 *
 * Opening is the promotion: a run the sidebar deliberately hides as noise
 * becomes a conversation the user has chosen to look at, so it belongs in
 * the sidebar like any other surfaced row, highlighted as active and still
 * there afterwards. Without this, a run opened from the activity feed
 * renders a chat with no corresponding sidebar row until the user sends a
 * message (`surfaceConversationAfterUserSend` owns that entry point; both
 * gate on {@link shouldSurfaceConversation}, so their eligibility cannot
 * drift).
 *
 * Server-first, like the send path: the POST carries the authoritative
 * `surfacedAt`, and the caches are written only from its response, so a
 * failed request leaves nothing to roll back. The in-flight set keeps one
 * request per conversation (the send path's idiom: each settle deletes only
 * its own entry, so overlapping opens of different runs cannot release each
 * other's guard) and releases on settle so a failed request retries on the
 * next effect evaluation; on success the row's own `surfacedAt` makes the
 * predicate false and the effect quiesces.
 */
export function useSurfaceOnOpen({
  assistantId,
  assistantStateKind,
  activeConversationId,
  activeConversation,
}: {
  assistantId: string | null;
  assistantStateKind: AssistantState["kind"];
  activeConversationId: string | null;
  activeConversation: Conversation | undefined;
}) {
  const queryClient = useQueryClient();
  const surfacingConversationIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (
      assistantStateKind !== "active" ||
      !assistantId ||
      !activeConversationId
    ) {
      return;
    }
    if (
      !activeConversation ||
      activeConversation.conversationId !== activeConversationId
    ) {
      return;
    }
    if (!shouldSurfaceConversation(activeConversation)) {
      return;
    }
    if (surfacingConversationIdsRef.current.has(activeConversationId)) {
      return;
    }

    surfacingConversationIdsRef.current.add(activeConversationId);
    const conversation = activeConversation;

    void surfaceConversation(assistantId, activeConversationId)
      .then((surfacedAt) => {
        applySurfacedConversation(
          queryClient,
          assistantId,
          conversation,
          surfacedAt,
        );
      })
      .catch((err: unknown) => {
        captureError(err, {
          context: "useSurfaceOnOpen",
          bestEffort: true,
          extra: { conversationId: activeConversationId },
        });
      })
      .finally(() => {
        surfacingConversationIdsRef.current.delete(activeConversationId);
      });
  }, [
    activeConversation,
    activeConversationId,
    assistantId,
    assistantStateKind,
    queryClient,
  ]);
}
