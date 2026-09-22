import { useMemo } from "react";

import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { useBackgroundTaskStore } from "@/domains/chat/background-task-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import {
  activityItemsToCardData,
  groupContentBlocks,
  groupOptionsForMessage,
  type ContentBlockGroup,
} from "@/domains/chat/transcript/message-content";
import {
  acpRunIdForCall,
  computeCardBackedWorkflowRunIds,
  extractBgIdFromResult,
  workflowRunIdForCall,
  type WorkflowCardBackingState,
} from "@/domains/chat/transcript/transcript-message-body-shared";
import { useHideThinkingUi } from "@/domains/chat/hooks/use-hide-thinking-ui";
import { useTranscriptMessageById } from "@/domains/chat/hooks/use-transcript-message-by-id";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { messageMatchKeys } from "@/domains/chat/utils/message-identity";
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

/** Whether the selected activity group is the final rendered content group. */
export function isLastActivityGroup(
  groups: ContentBlockGroup[],
  groupIndex: number,
): boolean {
  return (
    groups[groupIndex]?.type === "activity" && groupIndex === groups.length - 1
  );
}

/** Whether `message` is the transcript's final row by stable message identity. */
export function isLatestTranscriptMessage(
  message: DisplayMessage,
  transcriptMessages: readonly DisplayMessage[],
): boolean {
  const latest = transcriptMessages.at(-1);
  if (!latest) {
    return false;
  }
  const latestKeys = new Set(messageMatchKeys(latest));
  return messageMatchKeys(message).some((key) => latestKeys.has(key));
}

/** Locate the open activity block after pagination shifts numeric indexes. */
export function resolveActivityGroupIndex(
  groups: ContentBlockGroup[],
  groupIndex: number,
  anchorToolCallId?: string,
): number | null {
  if (!anchorToolCallId) {
    return groups[groupIndex]?.type === "activity" ? groupIndex : null;
  }
  const groupContainsAnchor = (candidateIndex: number): boolean => {
    const candidate = groups[candidateIndex];
    if (!candidate || candidate.type !== "activity") {
      return false;
    }
    return activityItemsToCardData(candidate.items).toolCalls.some(
      (toolCall) => toolCall.id === anchorToolCallId,
    );
  };
  if (groupContainsAnchor(groupIndex)) {
    return groupIndex;
  }
  const relocatedIndex = groups.findIndex((_, index) =>
    groupContainsAnchor(index),
  );
  return relocatedIndex === -1 ? null : relocatedIndex;
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
  anchorToolCallId?: string,
): {
  items: ToolCallCardItem[];
  toolCalls: ChatMessageToolCall[];
  isLastGroup: boolean;
  isLatestMessage: boolean;
  groupIndex: number;
} | null {
  const message = useTranscriptMessageById(messageId);
  const transcriptMessages = useTranscriptMessages();
  const hideThinkingUi = useHideThinkingUi();
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
    if (!message || groupIndex == null) {
      return null;
    }
    const groups = groupContentBlocks(
      message.contentBlocks ?? [],
      groupOptionsForMessage(message, hideThinkingUi),
    );
    const resolvedGroupIndex = resolveActivityGroupIndex(
      groups,
      groupIndex,
      anchorToolCallId,
    );
    if (resolvedGroupIndex == null) {
      return null;
    }
    const group = groups[resolvedGroupIndex];
    if (!group || group.type !== "activity") {
      return null;
    }
    const { cardItems, toolCalls } = activityItemsToCardData(group.items);
    return {
      ...filterCardBackedProcessCalls(cardItems, toolCalls, {
        workflow: {
          byId: workflowById,
          byToolUseId: workflowByToolUseId,
          notFoundRunIds: workflowNotFoundRunIds,
          hydrationFailedRunIds: workflowHydrationFailedRunIds,
        },
        acpById,
        acpByToolUseId,
        backgroundTaskById,
      }),
      isLastGroup: isLastActivityGroup(groups, resolvedGroupIndex),
      isLatestMessage: isLatestTranscriptMessage(message, transcriptMessages),
      groupIndex: resolvedGroupIndex,
    };
  }, [
    message,
    transcriptMessages,
    groupIndex,
    anchorToolCallId,
    hideThinkingUi,
    workflowById,
    workflowByToolUseId,
    workflowNotFoundRunIds,
    workflowHydrationFailedRunIds,
    acpById,
    acpByToolUseId,
    backgroundTaskById,
  ]);
}
