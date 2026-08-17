/**
 * Resolve the metadata row for the currently-open conversation.
 *
 * The row lives in exactly one list cache, and which one depends on the
 * conversation (foreground, background, scheduled, archived, or a section
 * window) and moves as it is pinned, filed, archived, or surfaced. A thread
 * opened directly (by URL or a deep link) may be in none of them yet, which
 * would leave the chat header, action menu, read-state, and the SSE
 * subscription (gated on `conversationExistsOnServer`) without a row.
 *
 * This hook follows the row wherever it lives (`useConversationRow`) and,
 * when no cache holds it, fetches that single row into its home cache.
 * Fetching one row keeps the active thread fully functional without
 * pulling any list onto the initial-render path, and reading it from the
 * list caches keeps one owner for the row: a placement or seen-state write
 * reaches this consumer the same way it reaches the sidebar.
 */

import { useEffect, useRef } from "react";
import { captureError } from "@/lib/sentry/capture-error";
import { useQueryClient } from "@tanstack/react-query";

import { useIsOrgReady } from "@/hooks/use-is-org-ready";

import type { Conversation } from "@/types/conversation-types";

import { useConversationRow } from "@/hooks/conversation-queries";
import { refreshConversationRow } from "@/utils/conversation-cache-mutations";

export function useActiveConversation(
  assistantId: string | null,
  conversationId: string | null | undefined,
  enabled: boolean,
): Conversation | undefined {
  const queryClient = useQueryClient();
  const isOrgReady = useIsOrgReady();
  const activeConversation = useConversationRow(assistantId, conversationId);

  const fetchedConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !assistantId || !conversationId || !isOrgReady) {
      return;
    }
    if (activeConversation) {
      return;
    }
    if (fetchedConversationIdRef.current === conversationId) {
      return;
    }
    fetchedConversationIdRef.current = conversationId;
    void refreshConversationRow(queryClient, assistantId, conversationId).catch(
      (error) => {
        fetchedConversationIdRef.current = null;
        captureError(error, {
          context: "useActiveConversation.refreshRow",
          bestEffort: true,
        });
      },
    );
  }, [
    enabled,
    assistantId,
    conversationId,
    activeConversation,
    queryClient,
    isOrgReady,
  ]);

  return activeConversation;
}
