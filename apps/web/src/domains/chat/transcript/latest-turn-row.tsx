
import { Fragment, memo, type ReactNode } from "react";

import type { MessageItem, TranscriptItem } from "@/domains/chat/transcript/types";

import { TranscriptRow } from "@/domains/chat/transcript/transcript-row";
import { useTurnStore } from "@/domains/chat/turn-store";
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
  assistantDisplayName?: string | null;
  onSurfaceAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
  onForkConversation?: (messageId: string) => void;
  onInspectMessage?: (messageId: string) => void;
  renderOnboardingChoice?: () => ReactNode;
  onOpenRuleEditor?: (context: {
    toolName: string;
    riskLevel?: string;
    riskReason?: string;
    input?: Record<string, unknown>;
    allowlistOptions: import("@/types/interaction-ui-types").AllowlistOption[];
    scopeOptions: import("@/types/interaction-ui-types").ScopeOption[];
    directoryScopeOptions: import("@/types/interaction-ui-types").DirectoryScopeOption[];
  }) => void;
  unknownNudgeToolCallIds?: Set<string>;
  onDismissUnknownNudge?: (toolCallId: string) => void;
  /** Callback when the user clicks Allow or Deny on an inline confirmation. */
  onConfirmationSubmit?: (
    decision: ConfirmationDecision,
    toolCall: ChatMessageToolCall,
  ) => void | Promise<void>;
  /** Callback when the user picks "Allow & Create Rule" from the split button. */
  onAllowAndCreateRule?: (toolCall: ChatMessageToolCall) => void | Promise<void>;
  onOpenApp?: (appId: string) => void;
  onOpenDocument?: (documentSurfaceId: string) => void;
  assistantId?: string | null;
  /** Click handler when the user clicks the "open timeline" button on an
   *  inline subagent progress card. */
  onSubagentClick?: (subagentId: string) => void;
  /** Callback to abort/stop a running subagent from an inline card. */
  onStopSubagent?: (subagentId: string) => void;
}

export const LatestTurnRow = memo(function LatestTurnRow({
  anchorMessage,
  responseItems,
  conversationId,
  assistantDisplayName,
  onSurfaceAction,
  onForkConversation,
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
}: LatestTurnRowProps) {
  // The response cluster is "streaming" whenever the turn is in flight. This
  // keeps each response message's last tool-call group expanded for the whole
  // turn, rather than only during the instants a tool reports `running`.
  const phase = useTurnStore.use.phase();
  const isStreaming =
    phase === "queued" || phase === "thinking" || phase === "streaming";
  return (
    <div className="flex flex-col" data-latest-turn="true">
      <TranscriptRow
        item={anchorMessage}
        conversationId={conversationId}
        assistantDisplayName={assistantDisplayName}
        onSurfaceAction={onSurfaceAction}
        onForkConversation={onForkConversation}
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
      />
      {responseItems.map((response) => (
        <Fragment key={response.key}>
          <TranscriptRow
            item={response}
            conversationId={conversationId}
            assistantDisplayName={assistantDisplayName}
            onSurfaceAction={onSurfaceAction}
            onForkConversation={onForkConversation}
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
            isStreaming={isStreaming}
          />
        </Fragment>
      ))}
    </div>
  );
});
