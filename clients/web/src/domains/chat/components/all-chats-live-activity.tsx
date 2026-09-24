import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { useBackgroundTaskStore } from "@/domains/chat/background-task-store";
import { AllChatsActivityBadge } from "@/domains/chat/components/all-chats-activity-badge";
import { ConversationActivityChips } from "@/domains/chat/components/conversation-activity-chips";
import type { ConversationActivity } from "@/domains/chat/hooks/use-conversation-activity";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useConversationStore } from "@/stores/conversation-store";
import type { Conversation } from "@/types/conversation-types";
import { isActiveAcpStatus } from "@/utils/acp-run-status";
import { isActiveBackgroundTaskStatus } from "@/utils/background-task-status";
import { isActiveStatus } from "@/utils/subagent-status";

/** Exact ownership avoids attributing unknown-parent activity to every chat. */
export function AllChatsLiveActivity({
  conversation,
}: {
  conversation: Conversation;
}) {
  const id = conversation.conversationId;
  const processing = useConversationStore((s) =>
    s.processingConversationIds.has(id),
  );
  const attention = useConversationStore((s) =>
    s.attentionConversationIds.has(id),
  );
  const subagents = useSubagentStore(
    useShallow((s) =>
      s.orderedIds.filter((key) => {
        const entry = s.byId[key];
        return (
          entry?.parentConversationId === id &&
          isActiveStatus(entry.status) &&
          entry.status !== "awaiting_input"
        );
      }),
    ),
  );
  const waiting = useSubagentStore((s) =>
    s.orderedIds.some((key) => {
      const entry = s.byId[key];
      return (
        entry?.parentConversationId === id && entry.status === "awaiting_input"
      );
    }),
  );
  const acp = useAcpRunStore(
    useShallow((s) =>
      s.orderedIds.filter((key) => {
        const entry = s.byId[key];
        return (
          entry?.parentConversationId === id && isActiveAcpStatus(entry.status)
        );
      }),
    ),
  );
  const tools = useBackgroundTaskStore(
    (s) =>
      s.orderedIds.filter((key) => {
        const entry = s.byId[key];
        return (
          entry?.conversationId === id &&
          isActiveBackgroundTaskStatus(entry.status)
        );
      }).length,
  );
  const activity = useMemo<ConversationActivity>(
    () => ({
      running: [
        ...subagents.map((key) => ({ kind: "subagent" as const, id: key })),
        ...acp.map((key) => ({ kind: "acp-run" as const, id: key })),
      ],
      completed: [],
      total: subagents.length + acp.length,
    }),
    [subagents, acp],
  );
  const count = activity.total + tools;
  if (
    !attention &&
    !waiting &&
    !processing &&
    !conversation.isProcessing &&
    count === 0
  ) {
    return null;
  }
  return (
    <AllChatsActivityBadge
      status={attention || waiting ? "attention" : "running"}
      count={Math.max(1, count)}
    >
      <ConversationActivityChips activity={activity} maxChips={2} />
    </AllChatsActivityBadge>
  );
}
