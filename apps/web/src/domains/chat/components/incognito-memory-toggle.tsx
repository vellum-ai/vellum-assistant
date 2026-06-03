/**
 * "Factor in memories" toggle for incognito conversations.
 *
 * Incognito conversations never produce memories, but can optionally recall
 * existing ones. This toggle controls that opt-in. It is rendered only when
 * the `incognito-conversations` flag is on AND the active conversation is
 * incognito.
 *
 * State sources, in precedence order:
 * - The server-backed `Conversation` row (conversation list query) supplies
 *   `incognito` / `factorInMemories` once a conversation is persisted.
 * - The client store (`getConversationSettings`) holds the draft intent for a
 *   not-yet-persisted conversation.
 *
 * Write paths mirror the per-conversation override pattern in
 * `composer-settings-menu.tsx`:
 * - Draft (only in the client store): update the store, no network call.
 * - Persisted (present in the server list): PUT
 *   `/v1/conversations/{id}/incognito`, optimistically reflect the value,
 *   invalidate the conversation list on success, roll back on failure.
 */

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Toggle } from "@vellum/design-library";
import { client } from "@/generated/api/client.gen";
import { useConversationListQuery } from "@/hooks/conversation-queries";
import { conversationsQueryKey } from "@/lib/sync/query-tags";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useConversationStore } from "@/stores/conversation-store";

interface Props {
  assistantId: string;
  conversationId: string | undefined;
}

export function IncognitoMemoryToggle({ assistantId, conversationId }: Props) {
  const queryClient = useQueryClient();
  const flagEnabled = useAssistantFeatureFlagStore.use.incognitoConversations();

  // Server-backed conversation row (foreground list). Present once the
  // conversation is persisted; absent for not-yet-sent drafts.
  const { conversations } = useConversationListQuery(assistantId);
  const serverConversation = conversationId
    ? conversations.find((c) => c.conversationId === conversationId)
    : undefined;

  // Client-store draft settings — reactive so the toggle reflects draft
  // incognito intent before the server assigns a real id.
  const conversationSettings = useConversationStore.use.conversationSettings();
  const storeSettings = conversationId
    ? conversationSettings.get(conversationId)
    : undefined;

  // A conversation is persisted when the server list holds a non-draft row.
  // Anything else (only in the client store, or flagged `draft`) updates the
  // store without a network call.
  const isPersisted = Boolean(serverConversation) && serverConversation?.draft !== true;

  const isIncognito =
    serverConversation?.incognito ?? storeSettings?.incognito ?? false;

  const initialFactorInMemories =
    serverConversation?.factorInMemories ?? storeSettings?.factorInMemories ?? false;

  const [checked, setChecked] = useState(initialFactorInMemories);

  // Keep local state in sync when the resolved source value changes (e.g. the
  // active conversation switches, or the server row loads/updates).
  useEffect(() => {
    setChecked(initialFactorInMemories);
  }, [initialFactorInMemories]);

  const handleChange = useCallback(
    async (next: boolean) => {
      if (!conversationId) return;

      if (!isPersisted) {
        // Draft: client-store only, no network.
        setChecked(next);
        useConversationStore
          .getState()
          .updateConversationSettings(conversationId, { factorInMemories: next });
        return;
      }

      // Persisted: optimistic update + PUT, rollback on failure.
      const previous = checked;
      setChecked(next);
      try {
        // Assistant-scoped path: the runtime-proxy interceptor only forwards
        // `/v1/assistants/{id}/conversations/...` to the gateway (self-hosted
        // and managed alike). A bare `/v1/conversations/...` is not proxied,
        // so the PUT would fail and the toggle would roll back.
        await client.put({
          url: `/v1/assistants/{assistant_id}/conversations/{conversation_id}/incognito`,
          path: { assistant_id: assistantId, conversation_id: conversationId },
          body: { factorInMemories: next },
          headers: { "Content-Type": "application/json" },
          throwOnError: true,
        });
        void queryClient.invalidateQueries({
          queryKey: conversationsQueryKey(assistantId),
        });
      } catch {
        setChecked(previous);
      }
    },
    [assistantId, conversationId, isPersisted, checked, queryClient],
  );

  if (!flagEnabled || !isIncognito) return null;

  return (
    <Toggle
      checked={checked}
      onChange={(next) => void handleChange(next)}
      label="Factor in memories"
      helperText="Incognito conversations never create memories, but can optionally read your existing ones."
    />
  );
}
