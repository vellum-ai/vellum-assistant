import { useMemo } from "react";

import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { useBackgroundTaskStore } from "@/domains/chat/background-task-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import {
  activityItemsToCardData,
  groupContentBlocks,
} from "@/domains/chat/transcript/message-content";
import {
  acpRunIdForCall,
  computeCardBackedWorkflowRunIds,
  extractBgIdFromResult,
  workflowRunIdForCall,
  type WorkflowCardBackingState,
} from "@/domains/chat/transcript/transcript-message-body-shared";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import { messageMatchKeys } from "@/domains/chat/utils/message-identity";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { ToolCallCardItem } from "@/domains/chat/utils/tool-call-card-utils";

/**
 * The store slices that decide whether a process tool call (`run_workflow`,
 * `acp_spawn`, backgrounded `bash`) is "card-backed" — rendered by its own
 * inline process card at the transcript level, and therefore suppressed from
 * the activity group's steps. Membership-only reads; the full stores satisfy
 * the shapes structurally.
 */
export interface ProcessCardBacking {
  workflow: WorkflowCardBackingState;
  acpById: Record<string, unknown>;
  acpByToolUseId: Map<string, string>;
  backgroundTaskById: Record<string, unknown>;
}

/**
 * Drop card-backed process calls from a group's card items + tool calls,
 * mirroring the suppression `TranscriptMessageBody` applies before handing a
 * group to `MultiActivityGroup` (same primitives: card-backed = the process
 * has a backing store entry / pending hydration; a failed call with no id
 * stays, so its error result remains visible as a step).
 */
export function filterCardBackedProcessCalls(
  cardItems: ToolCallCardItem[],
  toolCalls: ChatMessageToolCall[],
  backing: ProcessCardBacking,
): { items: ToolCallCardItem[]; toolCalls: ChatMessageToolCall[] } {
  const cardBackedWorkflowRunIds = computeCardBackedWorkflowRunIds(
    toolCalls,
    backing.workflow,
  );
  const isCardBacked = (tc: ChatMessageToolCall): boolean => {
    const runId = workflowRunIdForCall(tc, backing.workflow.byToolUseId);
    if (runId !== null && cardBackedWorkflowRunIds.has(runId)) {
      return true;
    }
    const acpId = acpRunIdForCall(tc, backing.acpByToolUseId);
    if (acpId !== null && backing.acpById[acpId] !== undefined) {
      return true;
    }
    const bgId = extractBgIdFromResult(tc);
    return bgId !== undefined && backing.backgroundTaskById[bgId] !== undefined;
  };
  const keptToolCalls = toolCalls.filter((tc) => !isCardBacked(tc));
  if (keptToolCalls.length === toolCalls.length) {
    return { items: cardItems, toolCalls };
  }
  const keptIds = new Set(keptToolCalls.map((tc) => tc.id));
  return {
    items: cardItems.filter(
      (it) => it.kind !== "toolCall" || keptIds.has(it.toolCall.id),
    ),
    toolCalls: keptToolCalls,
  };
}

/**
 * The ordered card items + tool calls of one activity group, re-derived from
 * the rendered transcript (server history ⊕ the in-flight turn) on every
 * render so an OPEN activity-steps panel streams — new steps append, running
 * steps settle — instead of freezing the snapshot captured when the panel was
 * opened. The group-level sibling of {@link useLiveThinkingText} /
 * {@link useLiveToolCall}, sharing {@link activityItemsToCardData} and the
 * card-backed process suppression with the transcript's `MultiActivityGroup`
 * props so the panel cannot drift from the inline view it mirrors.
 *
 * Returns `null` when the message or group can't be found (e.g. paged out of
 * the loaded transcript) so callers fall back to the open-time snapshot.
 */
export function useLiveActivityGroup(
  messageId: string | undefined,
  groupIndex: number | undefined,
): { items: ToolCallCardItem[]; toolCalls: ChatMessageToolCall[] } | null {
  const messages = useTranscriptMessages();
  // Card-backed process suppression reads the same store slices the
  // transcript subscribes to, so a card's backing flipping (an entry
  // appearing) drops the raw step from an open panel in the same render.
  const workflowById = useWorkflowStore.use.byId();
  const workflowByToolUseId = useWorkflowStore.use.byToolUseId();
  const workflowNotFoundRunIds = useWorkflowStore.use.notFoundRunIds();
  const workflowHydrationFailedRunIds =
    useWorkflowStore.use.hydrationFailedRunIds();
  const acpById = useAcpRunStore.use.byId();
  const acpByToolUseId = useAcpRunStore.use.byToolUseId();
  const backgroundTaskById = useBackgroundTaskStore.use.byId();

  return useMemo(() => {
    if (!messageId || groupIndex == null) {
      return null;
    }
    const message = messages.find((m) =>
      messageMatchKeys(m).includes(messageId),
    );
    if (!message) {
      return null;
    }
    const groups = groupContentBlocks(message.contentBlocks ?? [], {
      splitInlineThinking: message.role !== "user",
    });
    const group = groups[groupIndex];
    if (!group || group.type !== "activity") {
      return null;
    }
    const { cardItems, toolCalls } = activityItemsToCardData(group.items);
    return filterCardBackedProcessCalls(cardItems, toolCalls, {
      workflow: {
        byId: workflowById,
        byToolUseId: workflowByToolUseId,
        notFoundRunIds: workflowNotFoundRunIds,
        hydrationFailedRunIds: workflowHydrationFailedRunIds,
      },
      acpById,
      acpByToolUseId,
      backgroundTaskById,
    });
  }, [
    messages,
    messageId,
    groupIndex,
    workflowById,
    workflowByToolUseId,
    workflowNotFoundRunIds,
    workflowHydrationFailedRunIds,
    acpById,
    acpByToolUseId,
    backgroundTaskById,
  ]);
}
