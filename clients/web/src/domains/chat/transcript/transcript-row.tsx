import { memo, type ReactNode } from "react";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { StreamingShimmerText } from "@/domains/chat/components/streaming-shimmer-text";
import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import type { TranscriptItem } from "@/domains/chat/transcript/types";

import { PendingConfirmationRow } from "@/domains/chat/transcript/pending-confirmation-row";
import { PendingContactRequestRow } from "@/domains/chat/transcript/pending-contact-request-row";
import { PendingSecretRow } from "@/domains/chat/transcript/pending-secret-row";
import { TranscriptMessageBody } from "@/domains/chat/transcript/transcript-message-body";
import type { ConfirmationDecision } from "@/types/event-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

/**
 * Thin dispatcher: render one `TranscriptItem` using the matching existing
 * component for its `kind`.
 *
 * Interaction prompt items (`pendingSecret`, `pendingConfirmation`,
 * `pendingContactRequest`) render focused row components that read
 * interaction-store directly — no render-prop relay from the parent.
 */
export interface TranscriptRowProps {
  item: TranscriptItem;
  /** Conversation id, forwarded to message bodies for the bookmark toggle. */
  conversationId?: string | null;
  assistantDisplayName?: string | null;
  onSurfaceAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
  onForkConversation?: (messageId: string) => void;
  onSummarizeUpToHere?: (messageId: string) => void;
  onInspectMessage?: (messageId: string) => void;
  /** Render-prop for `kind: "onboardingChoice"` items. Onboarding depends on
   *  props from the parent (sendMessage, didOnboarding, etc.) and has a
   *  different lifecycle than interaction prompts, so it stays as a render-prop
   *  for now. */
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
  onAllowAndCreateRule?: (
    toolCall: ChatMessageToolCall,
  ) => void | Promise<void>;
  onOpenApp?: (appId: string) => void;
  onOpenDocument?: (documentSurfaceId: string) => void;
  /** Forwarded to inline app surfaces so they can render live preview iframes. */
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
  /** True when this row belongs to the actively-streaming turn. Forwarded to
   *  `TranscriptMessageBody` so the streaming message's last tool-call group
   *  defaults open. History rows leave it `false`. */
  isStreaming?: boolean;
  /** True for the final item of the latest turn. Forwarded to
   *  `TranscriptMessageBody` so the message directly above the parked avatar
   *  collapses its hover-actions row and animates it open on hover. */
  isLatestMessage?: boolean;
}

export const TranscriptRow = memo(function TranscriptRow({
  item,
  conversationId,
  assistantDisplayName,
  onSurfaceAction,
  onForkConversation,
  onSummarizeUpToHere,
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
  isStreaming,
  isLatestMessage,
}: TranscriptRowProps) {
  switch (item.kind) {
    case "message": {
      return (
        <TranscriptMessageBody
          message={item.message}
          conversationId={conversationId}
          assistantDisplayName={assistantDisplayName}
          onSurfaceAction={onSurfaceAction}
          onForkConversation={onForkConversation}
          onSummarizeUpToHere={onSummarizeUpToHere}
          onInspectMessage={onInspectMessage}
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
          isStreaming={isStreaming}
          isLatestMessage={isLatestMessage}
        />
      );
    }

    case "surface":
      return (
        <SurfaceRouter
          surface={item.surface}
          onAction={onSurfaceAction}
          onOpenApp={onOpenApp}
          onOpenDocument={onOpenDocument}
          assistantId={assistantId}
          assistantDisplayName={assistantDisplayName}
        />
      );

    case "thinking":
      // The turn-status slot. Mounted (fixed height) for the WHOLE in-flight
      // turn so the transcript never reflows around it; `item.active` fades
      // the shimmering label in only during the gaps where no other affordance
      // owns the progress signal — it hides while assistant text streams,
      // while an inline `SingleActivity` thinking link shimmers, and while a
      // prompt is pending (see `shouldShowThinkingIndicator`). Same bare
      // avatar-tinted shimmer treatment as the inline link so the handoff
      // reads as one continuous "Thinking" state; the three-dot typing pill it
      // replaces read as a competing third loading affordance.
      return (
        <div
          data-testid="transcript-thinking-row"
          data-active={item.active ? "true" : "false"}
          aria-hidden={!item.active}
          className={`flex h-7 items-center text-[13px] font-medium text-[var(--content-secondary)] transition-opacity duration-300 ${
            item.active ? "opacity-100" : "opacity-0"
          }`}
        >
          <StreamingShimmerText>{item.label ?? "Thinking"}</StreamingShimmerText>
        </div>
      );

    case "pendingSecret":
      return <PendingSecretRow />;

    case "pendingConfirmation":
      return <PendingConfirmationRow />;

    case "pendingContactRequest":
      return <PendingContactRequestRow />;

    case "ephemeralMeta":
      return (
        <div className="flex justify-start">
          <div className="max-w-full rounded-[var(--radius-lg)] bg-[var(--surface-overlay)] px-4 py-3 text-body-small-default text-[var(--content-secondary)]">
            <ChatMarkdownMessage content={item.result.text} hardLineBreaks />
          </div>
        </div>
      );

    case "onboardingChoice":
      if (renderOnboardingChoice) {
        return <>{renderOnboardingChoice()}</>;
      }
      return null;

    default: {
      // Exhaustiveness guard — TypeScript narrows `item` to `never` here.
      const _exhaustive: never = item;
      void _exhaustive;
      return null;
    }
  }
});
