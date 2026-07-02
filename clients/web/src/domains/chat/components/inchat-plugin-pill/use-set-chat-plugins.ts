import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";

import {
  conversationsByIdGetOptions,
  conversationsByIdGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { conversationsByIdEnabledpluginsPut } from "@/generated/daemon/sdk.gen";
import type { ConversationsByIdGetResponse } from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { useConversationStore } from "@/stores/conversation-store";
import { ApiError } from "@/utils/api-errors";
import { toast } from "@vellumai/design-library/components/toast";

import { useEffectiveChatPlugins } from "./use-effective-chat-plugins";

export interface UseSetChatPluginsResult {
  /**
   * True once the chat's row state is known — a loaded server row, or a settled
   * 404 confirming a draft — so a write routes deterministically. False while the
   * detail query is still pending/fetching or errored transiently (row state
   * unknown); `setPlugins`/`toggle` no-op in that window. Consumers disable the
   * control until this flips true.
   */
  canWrite: boolean;
  /**
   * Persist the chat's explicit plugin scope. `null` clears the scope back to
   * the default (every installed plugin selected). Routes to the daemon for a
   * loaded server row, or to the composer draft stash for a confirmed draft.
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
 * Existing-vs-draft precedence keys off the conversation detail query's STATUS,
 * not just data presence — a still-loading existing chat must not be mistaken
 * for a draft (its click would land in `pendingDraftPlugins` and silently lose
 * to the row once it loads):
 *
 * - **Existing/sent conversation** (detail query resolved with a row): PUT the
 *   set to `conversationsByIdEnabledpluginsPut`, optimistically write
 *   `conversation.enabledPlugins` into the conversation query cache, invalidate
 *   once the send settles, and roll back + toast on failure — the persist
 *   pattern from `ComposerSettingsMenu.handleProfileSelect`.
 * - **Draft** (detail query settled to a 404 — no such row): stash on the
 *   conversation store's `pendingDraftPlugins`, no network.
 * - **Unknown** (query pending/fetching, or errored transiently): no-op, and
 *   `canWrite` is false so the pill disables itself until the state is known.
 *
 * Rapid toggles coalesce: PUTs are serialized and re-sent whenever a newer
 * selection arrived mid-flight, so concurrent toggles collapse to the final
 * state and an older request can't overwrite a newer one.
 */
export function useSetChatPlugins(
  assistantId: string | null,
  conversationId: string | undefined,
): UseSetChatPluginsResult {
  const queryClient = useQueryClient();
  const { plugins } = useEffectiveChatPlugins(assistantId, conversationId);

  const convEnabled = Boolean(assistantId) && Boolean(conversationId);
  const convQuery = useQuery({
    ...conversationsByIdGetOptions({
      path: { assistant_id: assistantId ?? "", id: conversationId ?? "" },
    }),
    enabled: convEnabled,
  });

  const hasServerRow =
    convQuery.isSuccess && Boolean(convQuery.data?.conversation);
  const isConfirmedDraft =
    convQuery.isError &&
    convQuery.error instanceof ApiError &&
    convQuery.error.status === 404;
  const canWrite = convEnabled && (hasServerRow || isConfirmedDraft);

  // Coalescing state for the serialized PUT loop. `desiredRef` holds the latest
  // requested set; `sendingRef` guards a single in-flight loop; `rollbackRef`
  // snapshots server truth captured before a burst's first optimistic write.
  const desiredRef = useRef<string[] | null>(null);
  const sendingRef = useRef(false);
  const rollbackRef = useRef<ConversationsByIdGetResponse | undefined>(undefined);

  const setPlugins = useCallback(
    (next: string[] | null) => {
      // Row state unknown (or nothing to target) — never write blindly.
      if (!canWrite || !assistantId || !conversationId) return;

      // Confirmed draft — stash the selection locally; the send path attaches it
      // to the minted conversation. No network, no rollback.
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
      if (!sendingRef.current) {
        rollbackRef.current =
          queryClient.getQueryData<ConversationsByIdGetResponse>(key);
      }
      queryClient.setQueryData<ConversationsByIdGetResponse>(key, (old) =>
        old
          ? {
              ...old,
              conversation: { ...old.conversation, enabledPlugins: next },
            }
          : old,
      );
      desiredRef.current = next;

      // A loop is already draining the latest desired set — let it pick this up.
      if (sendingRef.current) return;

      sendingRef.current = true;
      void (async () => {
        try {
          // Send-until-stable: serialize PUTs and re-send whenever a newer
          // selection arrived mid-flight, so the last selection wins and older
          // requests can't overwrite it.
          let target = desiredRef.current;
          let stable = false;
          while (!stable) {
            await conversationsByIdEnabledpluginsPut({
              path: { assistant_id: assistantId, id: conversationId },
              body: { enabledPlugins: target },
              throwOnError: true,
            });
            if (desiredRef.current === target) {
              stable = true;
            } else {
              target = desiredRef.current;
            }
          }
        } catch (err) {
          // Roll back to the pre-burst server truth, then surface the failure.
          if (rollbackRef.current !== undefined) {
            queryClient.setQueryData(key, rollbackRef.current);
          }
          captureError(err, { context: "useSetChatPlugins.setPlugins" });
          toast.error("Failed to update plugins. Please try again.");
        } finally {
          sendingRef.current = false;
          // Reconcile with server truth once the loop settles.
          void queryClient.invalidateQueries({ queryKey: key });
        }
      })();
    },
    [assistantId, conversationId, canWrite, hasServerRow, queryClient],
  );

  const toggle = useCallback(
    (name: string) => {
      if (!canWrite) return;
      const nextSet = new Set(
        plugins.filter((plugin) => plugin.selected).map((plugin) => plugin.name),
      );
      if (nextSet.has(name)) nextSet.delete(name);
      else nextSet.add(name);
      setPlugins([...nextSet]);
    },
    [plugins, setPlugins, canWrite],
  );

  return { canWrite, setPlugins, toggle };
}
