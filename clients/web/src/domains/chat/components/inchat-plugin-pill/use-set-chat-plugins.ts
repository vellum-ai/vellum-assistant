import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  conversationsByIdGetOptions,
  conversationsByIdGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { conversationsByIdEnabledpluginsPut } from "@/generated/daemon/sdk.gen";
import type { ConversationsByIdGetResponse } from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { useConversationStore } from "@/stores/conversation-store";
import { toast } from "@vellumai/design-library/components/toast";

import { useEffectiveChatPlugins } from "./use-effective-chat-plugins";

export interface UseSetChatPluginsResult {
  /**
   * Persist the chat's explicit plugin scope. `null` clears the scope back to
   * the default (every installed plugin selected). Routes to the daemon for a
   * loaded server row, or to the composer draft stash otherwise.
   */
  setPlugins: (next: string[] | null) => void;
  /**
   * Flip a single plugin on/off. Materializes the explicit set from the current
   * effective selection (opt-out default → "all installed except the toggled-off
   * one", mirroring `use-new-chat-plugins.ts`), then routes it through
   * `setPlugins`.
   */
  toggle: (name: string) => void;
}

/**
 * Write half of the in-chat plugin pill: persists a chat's plugin selection.
 *
 * Existing-vs-draft precedence mirrors `useEffectiveChatPlugins` /
 * `use-active-profile-model.ts`:
 *
 * - **Existing/sent conversation** (a server row is loaded via
 *   `conversationsByIdGetOptions`): PUT the set to
 *   `conversationsByIdEnabledpluginsPut`, optimistically write
 *   `conversation.enabledPlugins` into the conversation query cache, invalidate
 *   on settle, and roll back + toast on failure — the persist pattern from
 *   `ComposerSettingsMenu.handleProfileSelect`.
 * - **Draft** (no server row): stash on the conversation store's
 *   `pendingDraftPlugins`, no network.
 */
export function useSetChatPlugins(
  assistantId: string | null,
  conversationId: string | undefined,
): UseSetChatPluginsResult {
  const queryClient = useQueryClient();
  const { plugins } = useEffectiveChatPlugins(assistantId, conversationId);

  const { data: convData } = useQuery({
    ...conversationsByIdGetOptions({
      path: { assistant_id: assistantId ?? "", id: conversationId ?? "" },
    }),
    enabled: Boolean(assistantId) && Boolean(conversationId),
  });
  const hasServerRow = Boolean(convData?.conversation);

  const setPlugins = useCallback(
    (next: string[] | null) => {
      if (!assistantId || !conversationId) return;

      // Draft — no server row yet. Stash the selection locally; the send path
      // attaches it to the minted conversation. No network, no rollback.
      if (!hasServerRow) {
        const store = useConversationStore.getState();
        if (next === null) {
          store.clearPendingDraftPlugins(conversationId);
        } else {
          store.setPendingDraftPlugins(conversationId, new Set(next));
        }
        return;
      }

      // Existing/sent conversation — persist to the daemon with an optimistic
      // cache write so the pill/menu reflect the change before the round trip.
      const key = conversationsByIdGetQueryKey({
        path: { assistant_id: assistantId, id: conversationId },
      });
      const previous =
        queryClient.getQueryData<ConversationsByIdGetResponse>(key);
      queryClient.setQueryData<ConversationsByIdGetResponse>(key, (old) =>
        old
          ? {
              ...old,
              conversation: { ...old.conversation, enabledPlugins: next },
            }
          : old,
      );

      void (async () => {
        try {
          await conversationsByIdEnabledpluginsPut({
            path: { assistant_id: assistantId, id: conversationId },
            body: { enabledPlugins: next },
            throwOnError: true,
          });
        } catch (err) {
          // Roll back the optimistic write, then surface the failure.
          if (previous !== undefined) {
            queryClient.setQueryData(key, previous);
          }
          captureError(err, { context: "useSetChatPlugins.setPlugins" });
          toast.error("Failed to update plugins. Please try again.");
        } finally {
          void queryClient.invalidateQueries({ queryKey: key });
        }
      })();
    },
    [assistantId, conversationId, hasServerRow, queryClient],
  );

  const toggle = useCallback(
    (name: string) => {
      const nextSet = new Set(
        plugins.filter((plugin) => plugin.selected).map((plugin) => plugin.name),
      );
      if (nextSet.has(name)) nextSet.delete(name);
      else nextSet.add(name);
      setPlugins([...nextSet]);
    },
    [plugins, setPlugins],
  );

  return { setPlugins, toggle };
}
