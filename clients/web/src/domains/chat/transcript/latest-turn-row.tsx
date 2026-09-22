import type { ResponseArtifact } from "@/domains/chat/transcript/response-artifacts";
import { memo, type ReactNode } from "react";

import type {
  MessageItem,
  TranscriptItem,
} from "@/domains/chat/transcript/types";

import { TranscriptRow } from "@/domains/chat/transcript/transcript-row";
import { LatestTurnResponse } from "@/domains/chat/transcript/latest-turn-response";
import { isActivityLive, useTurnStore } from "@/domains/chat/turn-store";
import type { ConfirmationDecision } from "@/types/event-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

/**
 * Renders the newest user message (the "anchor") plus any response items
 * that have streamed in since it was sent.
 *
 * The viewport-min-height wrapper that pins the anchor to the top of the
 * viewport — and the assistant avatar that pins to the bottom of the
 * viewport — both live in `Transcript`. This component is just the
 * anchor + response cluster; it has no awareness of where it sits inside
 * the latest-edge region.
 */
export interface LatestTurnRowProps {
  anchorMessage: MessageItem;
  responseItems: TranscriptItem[];
  /** Conversation id, forwarded to message bodies for the bookmark toggle. */
  conversationId?: string | null;
  /** Tool call the inline Connect card renders under, resolved once by
   *  `Transcript`. The latest turn is where a fresh spawn failure lands, so
   *  dropping it here is what would leave that card unrendered. */
  acpConnectInlineToolUseId?: string | null;
  assistantDisplayName?: string | null;
  onSurfaceAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
  onForkConversation?: (messageId: string) => void;
  onSummarizeUpToHere?: (messageId: string) => void;
  onRetryLatestTurn?: () => void;
  onInspectMessage?: (messageId: string) => void;
  renderOnboardingChoice?: () => ReactNode;
  onOpenRuleEditor?: (context: {
    toolName: string;
    riskLevel?: string;
    riskReason?: string;
    input?: Record<string, unknown>;
    allowlistOptions: import("@/types/interaction-ui-types").AllowlistOption[];
    scopeOptions: import("@/types/interaction-ui-types").ScopeOption[];
  }) => void;
  unknownNudgeToolCallIds?: Set<string>;
  onDismissUnknownNudge?: (toolCallId: string) => void;
  /** Callback when the user clicks Allow or Deny on an inline confirmation. */
  onConfirmationSubmit?: (
    decision: ConfirmationDecision,
    toolCall: ChatMessageToolCall,
  ) => void | Promise<void>;
  /** Callback when the user picks "Allow & Create Rule" from the split button. */
  onAllowAndCreateRule?: (
    toolCall: ChatMessageToolCall,
  ) => void | Promise<void>;
  onOpenApp?: (appId: string) => void;
  onOpenDocument?: (documentSurfaceId: string) => void;
  assistantId?: string | null;
  /** Click handler when the user clicks the "open timeline" button on an
   *  inline subagent progress card. */
  onSubagentClick?: (subagentId: string) => void;
  /** Callback to abort/stop a running subagent from an inline card. */
  onStopSubagent?: (subagentId: string) => void;
  /** Click handler when the user clicks the open button on an inline workflow
   *  progress card. */
  onWorkflowClick?: (runId: string) => void;
  /** Callback to abort/stop a running workflow from an inline card. */
  onStopWorkflow?: (runId: string) => void;
  /** Changed-document ids per transcript item key, resolved across whole
   *  responses by `Transcript`. Only the message that ends a completed response
   *  has an entry, and the in-flight response has none. */
  responseArtifactsByKey?: ReadonlyMap<string, ResponseArtifact[]>;
}

export const LatestTurnRow = memo(function LatestTurnRow({
  anchorMessage,
  responseItems,
  conversationId,
  acpConnectInlineToolUseId,
  assistantDisplayName,
  onSurfaceAction,
  onForkConversation,
  onSummarizeUpToHere,
  onRetryLatestTurn,
  onInspectMessage,
  renderOnboardingChoice,
  onOpenRuleEditor,
  unknownNudgeToolCallIds,
  onDismissUnknownNudge,
  onConfirmationSubmit,
  onAllowAndCreateRule,
  onOpenApp,
  onOpenDocument,
  assistantId,
  onSubagentClick,
  onStopSubagent,
  onWorkflowClick,
  onStopWorkflow,
  responseArtifactsByKey,
}: LatestTurnRowProps) {
  // The response cluster is "streaming" while response output can still
  // append. This keeps each response message's last tool-call group expanded
  // between tool updates and settles it while awaiting user input.
  const phase = useTurnStore.use.phase();
  const isStreaming = isActivityLive(phase);
  // The last message-kind item of the cluster is the latest message
  // (see `TranscriptRowProps.isLatestMessage`). Trailing non-message rows —
  // the thinking slot, pending prompts — carry no trailer of their own, so
  // Retry stays on the last assistant message while the turn is still
  // streaming, not just after it settles.
  return (
    <div className="flex flex-col" data-latest-turn="true">
      <TranscriptRow
        item={anchorMessage}
        conversationId={conversationId}
        acpConnectInlineToolUseId={acpConnectInlineToolUseId}
        assistantDisplayName={assistantDisplayName}
        onSurfaceAction={onSurfaceAction}
        onForkConversation={onForkConversation}
        onSummarizeUpToHere={onSummarizeUpToHere}
        onRetryLatestTurn={onRetryLatestTurn}
        onInspectMessage={onInspectMessage}
        renderOnboardingChoice={renderOnboardingChoice}
        onOpenRuleEditor={onOpenRuleEditor}
        unknownNudgeToolCallIds={unknownNudgeToolCallIds}
        onDismissUnknownNudge={onDismissUnknownNudge}
        onConfirmationSubmit={onConfirmationSubmit}
        onAllowAndCreateRule={onAllowAndCreateRule}
        onOpenApp={onOpenApp}
        onOpenDocument={onOpenDocument}
        assistantId={assistantId}
        onSubagentClick={onSubagentClick}
        onStopSubagent={onStopSubagent}
        onWorkflowClick={onWorkflowClick}
        onStopWorkflow={onStopWorkflow}
        isLatestMessage={!responseItems.some((item) => item.kind === "message")}
      />
      <LatestTurnResponse
        responseItems={responseItems}
        conversationId={conversationId}
        acpConnectInlineToolUseId={acpConnectInlineToolUseId}
        assistantDisplayName={assistantDisplayName}
        onSurfaceAction={onSurfaceAction}
        onForkConversation={onForkConversation}
        onSummarizeUpToHere={onSummarizeUpToHere}
        onRetryLatestTurn={onRetryLatestTurn}
        onInspectMessage={onInspectMessage}
        renderOnboardingChoice={renderOnboardingChoice}
        onOpenRuleEditor={onOpenRuleEditor}
        unknownNudgeToolCallIds={unknownNudgeToolCallIds}
        onDismissUnknownNudge={onDismissUnknownNudge}
        onConfirmationSubmit={onConfirmationSubmit}
        onAllowAndCreateRule={onAllowAndCreateRule}
        onOpenApp={onOpenApp}
        onOpenDocument={onOpenDocument}
        assistantId={assistantId}
        onSubagentClick={onSubagentClick}
        onStopSubagent={onStopSubagent}
        onWorkflowClick={onWorkflowClick}
        onStopWorkflow={onStopWorkflow}
        responseArtifactsByKey={responseArtifactsByKey}
        isStreaming={isStreaming}
      />
    </div>
  );
});
