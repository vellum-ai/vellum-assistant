/**
 * Resolve the metadata row for the currently-open conversation.
 *
 * The foreground list query holds only foreground conversations, while the
 * Background and Scheduled lists load lazily through separate queries — only
 * once the user reveals their sidebar sections. A background or scheduled
 * thread opened directly (by URL or a deep link) is therefore absent from
 * every loaded list, which would leave the chat header, action menu,
 * read-state, and the SSE subscription (gated on `conversationExistsOnServer`)
 * without a row to work from.
 *
 * This hook reads the row from whichever list cache already holds it and,
 * when it is in none, fetches that single row into the cache. Fetching one
 * row keeps the active thread fully functional without pulling the entire
 * background or scheduled backlog onto the initial-render path.
 */

import { useEffect, useMemo, useRef } from "react";
import { captureError } from "@/lib/sentry/capture-error";
import { useQueryClient } from "@tanstack/react-query";

import { useIsOrgReady } from "@/hooks/use-is-org-ready";

import type { Conversation } from "@/types/conversation-types";

import {
  useBackgroundConversationListQuery,
  useConversationListQuery,
  useScheduledConversationListQuery,
} from "@/hooks/conversation-queries";
import { refreshConversationRow } from "@/utils/conversation-cache-mutations";

export function useActiveConversation(
  assistantId: string | null,
  conversationId: string | null | undefined,
  enabled: boolean,
): Conversation | undefined {
  const queryClient = useQueryClient();
  const isOrgReady = useIsOrgReady();
  const { conversations: foreground } = useConversationListQuery(
    assistantId,
    enabled,
  );
  // Read-only subscriptions (`enabled: false`): reflect background and
  // scheduled rows already in cache — including the single row fetched below
  // — without triggering either lazy list fetch.
  const { conversations: background } = useBackgroundConversationListQuery(
    assistantId,
    false,
  );
  const { conversations: scheduled } = useScheduledConversationListQuery(
    assistantId,
    false,
  );

  const activeConversation = useMemo(() => {
    if (!conversationId) {
      return undefined;
    }
    return (
      foreground.find((c) => c.conversationId === conversationId) ??
      background.find((c) => c.conversationId === conversationId) ??
      scheduled.find((c) => c.conversationId === conversationId)
    );
  }, [foreground, background, scheduled, conversationId]);

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
    void refreshConversationRow(
      queryClient,
      assistantId,
      conversationId,
    ).catch((error) => {
      fetchedConversationIdRef.current = null;
      captureError(error, {
        context: "useActiveConversation.refreshRow",
        bestEffort: true,
      });
    });
  }, [enabled, assistantId, conversationId, activeConversation, queryClient, isOrgReady]);

  return activeConversation;
}
