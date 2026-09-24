import { useEffect, useMemo } from "react";

import { reconcileAcpSessions } from "@/domains/chat/hooks/use-acp-run-rehydration";
import { reconcileBackgroundTasks } from "@/domains/chat/hooks/use-background-task-rehydration";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { createVisibleChatReconciler } from "@/domains/chat/utils/visible-chat-reconciler";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useSupportsSubagentsReconcile } from "@/lib/backwards-compat/subagents-reconcile";

const ACTIVITY_EVENTS = new Set([
  "subagent_spawned",
  "subagent_status_changed",
  "acp_session_spawned",
  "acp_session_completed",
  "acp_session_error",
  "background_tool_started",
  "background_tool_completed",
]);

/** Hydrates only mounted rows, with the same snapshot rules as the open chat. */
export function useAllChatsActivityRefresh(
  assistantId: string,
  enabled: boolean,
) {
  const orgReady = useIsOrgReady();
  const supportsSubagents = useSupportsSubagentsReconcile();
  const reconciler = useMemo(
    () =>
      createVisibleChatReconciler(async (id, isCurrent) => {
        if (supportsSubagents && isCurrent()) {
          await useSubagentStore
            .getState()
            .reconcileFromDaemon(assistantId, id, "reopen");
        }
        if (isCurrent()) {
          await reconcileAcpSessions(assistantId, id, isCurrent, false);
        }
        if (isCurrent()) {
          await reconcileBackgroundTasks(assistantId, id, isCurrent);
        }
      }),
    [assistantId, supportsSubagents],
  );

  useEffect(() => {
    if (enabled && orgReady) {
      reconciler.start();
    }
    return () => reconciler.stop();
  }, [reconciler, enabled, orgReady]);

  useBusSubscription("sse.opened", ({ assistantId: openedFor, cause }) => {
    if (openedFor === assistantId && cause !== "anchor") {
      reconciler.refresh();
    }
  });
  useBusSubscription("app.resume", () => reconciler.refresh());
  useBusSubscription("sse.event", ({ message, conversationId }) => {
    if (!ACTIVITY_EVENTS.has(message.type)) {
      return;
    }
    const owner =
      conversationId ||
      ("parentConversationId" in message
        ? message.parentConversationId
        : undefined) ||
      ("conversationId" in message ? message.conversationId : undefined) ||
      ("subagentId" in message
        ? useSubagentStore.getState().byId[message.subagentId]
            ?.parentConversationId
        : undefined) ||
      ("acpSessionId" in message
        ? useAcpRunStore.getState().byId[message.acpSessionId]
            ?.parentConversationId
        : undefined);
    reconciler.refresh(owner);
  });

  return reconciler.register;
}
