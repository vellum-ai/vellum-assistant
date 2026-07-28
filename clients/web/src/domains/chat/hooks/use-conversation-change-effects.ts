/**
 * Consolidates side effects that fire when `activeConversationId` changes:
 *
 * - Reset subagent tracking state (needed for URL-navigation paths that
 *   bypass the `switchConversation` / `startNewConversation` wrappers)
 * - Reconcile-on-load (0.11.0+): materialize store entries for every
 *   subagent the daemon knows about in this conversation, so subagents
 *   whose `subagent_spawned` this client never saw (page reload mid-run,
 *   another device, a store reset) get cards without waiting for their
 *   next stream event
 * - Auto-fetch detail for subagents reconstructed from history or
 *   reconcile (entries with a `conversationId` but no events yet)
 *
 * Note: interaction store cleanup (`dismissQuestion`, `resetAll`) is NOT
 * handled here — `switchToConversation()` in `chat-session-store` already
 * calls `useInteractionStore.getState().resetAll()` on every conversation
 * switch, covering both wrapper-initiated and URL-navigation paths.
 */

import { useEffect, useLayoutEffect } from "react";

import { SubagentStatusSchema } from "@vellumai/assistant-api";

import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { subagentsReconcileGet } from "@/generated/daemon/sdk.gen";
import { useSupportsSubagentRecovery } from "@/lib/backwards-compat/subagent-recovery";
import { useConversationStore } from "@/stores/conversation-store";

export function useConversationChangeEffects(
  assistantId: string | null,
  activeConversationId: string | null,
): void {
  // Reset subagent + workflow tracking on conversation change. Runs as a
  // layout effect so it completes before any freshly-mounted card's passive
  // hydration effect: every `useLayoutEffect` in the tree fires before any
  // `useEffect`, so this reset's `generation` bump lands before a child card
  // calls `hydrateRunIfNeeded`. As a passive effect it would run after the
  // child (effects fire children-first), letting a card capture the pre-reset
  // `generation`; the reset would then bump it and the in-flight hydration
  // would discard its own result as stale — leaving the card blank with no
  // retry. The wrapper-initiated path (`switchConversation` /
  // `startNewConversation`) also resets eagerly; the double-reset is idempotent.
  // This effect catches the URL-navigation path where wrappers don't run.
  useLayoutEffect(() => {
    useSubagentStore.getState().reset();
    useWorkflowStore.getState().reset();
  }, [activeConversationId]);

  // Reconcile-on-load: ask the daemon which subagents belong to this
  // conversation and materialize entries for any the store doesn't have.
  // This is the recovery path that needs no stream evidence at all — a
  // subagent that stays quiet after a reset/reload still gets its card (a
  // stream event would also recover it via `ensureEntry`, but only when it
  // next emits). Runs as a passive effect, i.e. after the layout reset
  // above, so a conversation change can't wipe what this seeds. Version
  // gated: pre-0.11.0 daemons return status-only reconcile data, which
  // can't seed a usable entry.
  const supportsRecovery = useSupportsSubagentRecovery();
  useEffect(() => {
    if (!assistantId || !activeConversationId || !supportsRecovery) {
      return;
    }
    const requestedConversationId = activeConversationId;
    void (async () => {
      try {
        const { data, response } = await subagentsReconcileGet({
          path: { assistant_id: assistantId },
          query: { parentConversationId: requestedConversationId },
          throwOnError: false,
        });
        if (!response?.ok || !data) {
          return;
        }
        // A switch while the request was in flight: these subagents belong
        // to a conversation no longer in view.
        if (
          useConversationStore.getState().activeConversationId !==
          requestedConversationId
        ) {
          return;
        }
        const store = useSubagentStore.getState();
        for (const [subagentId, info] of Object.entries(data.subagents ?? {})) {
          if (store.byId[subagentId]) {
            continue;
          }
          const status = SubagentStatusSchema.safeParse(info.status);
          store.ensureEntry({
            subagentId,
            timestamp: Date.now(),
            conversationId: info.conversationId,
            ...(status.success ? { status: status.data } : {}),
            label: info.label,
            parentToolUseId: info.parentToolUseId,
          });
        }
      } catch {
        // Best-effort — stream evidence and history hydration still recover.
      }
    })();
  }, [assistantId, activeConversationId, supportsRecovery]);

  // Stable signal: changes only when the set of subagent IDs that need a
  // detail fetch changes (entry appears with conversationId + no events,
  // or an entry receives events). Immune to loadDetail calls that update
  // status/objective without changing events, preventing retrigger loops.
  const unfetchedSubagentKey = useSubagentStore((s) => {
    const ids: string[] = [];
    for (const entry of Object.values(s.byId)) {
      if (entry.conversationId && entry.events.length === 0) {
        ids.push(entry.subagentId);
      }
    }
    return ids.sort().join(",");
  });

  // Auto-fetch details for subagents reconstructed from history
  useEffect(() => {
    if (!assistantId || !unfetchedSubagentKey) {
      return;
    }
    for (const entry of Object.values(useSubagentStore.getState().byId)) {
      if (entry.conversationId && entry.events.length === 0) {
        void useSubagentStore
          .getState()
          .fetchDetailIfNeeded(assistantId, entry.subagentId);
      }
    }
  }, [assistantId, unfetchedSubagentKey]);
}
