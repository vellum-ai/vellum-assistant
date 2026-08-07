import {
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { CreditsUpsellCard } from "@/domains/chat/components/credits-upsell-card";
import { MessageHoverActions } from "@/domains/chat/components/message-hover-actions/message-hover-actions";
import { StreamingShimmerText } from "@/domains/chat/components/streaming-shimmer-text";
import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import type { TranscriptItem } from "@/domains/chat/transcript/types";

import { PendingConfirmationRow } from "@/domains/chat/transcript/pending-confirmation-row";
import { PendingContactRequestRow } from "@/domains/chat/transcript/pending-contact-request-row";
import { PendingSecretRow } from "@/domains/chat/transcript/pending-secret-row";
import { SystemCardRow } from "@/domains/chat/transcript/system-card-row";
import { TranscriptMessageBody } from "@/domains/chat/transcript/transcript-message-body";
import { isInteractiveClickTarget } from "@/domains/chat/transcript/transcript-message-body-shared";
import { useCoarsePointerReveal } from "@/domains/chat/transcript/use-coarse-pointer-reveal";
import { isPointerCoarse } from "@/utils/pointer";
import type { ConfirmationDecision } from "@/types/event-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayMessage } from "@/domains/chat/types/types";

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
  onRetryLatestTurn?: () => void;
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
  /** Assistant that owns this transcript. Forwarded to inline app surfaces so
   *  they can render live preview iframes, and to every markdown renderer in
   *  the row so workspace file references resolve against its workspace. */
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
  /** Ids of the documents this message's whole response changed. Set only on
   *  the message that ends a completed response, so the response closes with
   *  one reopen link per document (see `resolveResponseDocumentIds`). */
  changedDocumentIds?: string[];
  /** True when this row belongs to the actively-streaming turn. Forwarded to
   *  `TranscriptMessageBody` so the streaming message's last tool-call group
   *  defaults open. History rows leave it `false`. */
  isStreaming?: boolean;
  /** True for the final item of the latest turn. Forwarded to
   *  `TranscriptMessageBody` so the message directly above the parked avatar
   *  collapses its hover-actions row and animates it open on hover. */
  isLatestMessage?: boolean;
}

/**
 * A credits upsell card substituted for a credits-exhausted provider-error
 * row: a standalone card, outside the persona bubble/avatar machinery like
 * `SystemCardRow`. It keeps the `msg-<id>` DOM anchor that
 * `TranscriptHandle.scrollToMessage` and the `?message=<id>` deep link
 * resolve via `getElementById`, and exposes the same Inspect affordance as
 * ordinary rows: the daemon backfills the failed request's LLM logs onto
 * this row's message id, and inspection is their only entry point while the
 * bubble is substituted. The actions reveal on hover/focus-visible, and on
 * coarse pointers via tap (dismissed by tapping outside), mirroring
 * `TranscriptMessageBody`'s reveal behavior.
 */
function CreditsUpsellMessageRow({
  message,
  conversationId,
  onInspectMessage,
}: {
  message: DisplayMessage;
  conversationId?: string | null;
  onInspectMessage?: (messageId: string) => void;
}) {
  const { wrapperRef, revealed, toggleRevealed } = useCoarsePointerReveal();
  const handleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (isInteractiveClickTarget(e.target as Element | null)) {
      return;
    }
    if (!isPointerCoarse()) {
      return;
    }
    toggleRevealed();
  };

  const messageId = message.id;
  const inspectHandler =
    onInspectMessage && messageId
      ? () => onInspectMessage(messageId)
      : undefined;
  return (
    <div
      ref={wrapperRef}
      id={messageId ? `msg-${messageId}` : undefined}
      data-message-id={messageId || undefined}
      data-revealed={revealed}
      onClick={handleClick}
      className="group/msg flex flex-col gap-2"
    >
      <CreditsUpsellCard />
      {inspectHandler && (
        <div className="h-6 overflow-hidden opacity-0 transition-opacity duration-200 ease-out group-hover/msg:opacity-100 has-[:focus-visible]:opacity-100 group-data-[revealed=true]/msg:opacity-100 motion-reduce:transition-none">
          <MessageHoverActions
            message={message}
            conversationId={conversationId}
            onInspect={inspectHandler}
          />
        </div>
      )}
    </div>
  );
}

export const TranscriptRow = memo(function TranscriptRow({
  item,
  conversationId,
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
  changedDocumentIds,
  isStreaming,
  isLatestMessage,
}: TranscriptRowProps) {
  switch (item.kind) {
    case "message": {
      // Daemon-authored status cards render as standalone system notices,
      // outside the persona bubble/avatar/hover-action machinery.
      if (item.message.isSystemCard) {
        return (
          <SystemCardRow message={item.message} assistantId={assistantId} />
        );
      }
      return (
        <TranscriptMessageBody
          message={item.message}
          conversationId={conversationId}
          assistantDisplayName={assistantDisplayName}
          onSurfaceAction={onSurfaceAction}
          onForkConversation={onForkConversation}
          onSummarizeUpToHere={onSummarizeUpToHere}
          onRetryLatestTurn={onRetryLatestTurn}
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
          changedDocumentIds={changedDocumentIds}
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
      // The turn-status slot. Mounted for the WHOLE in-flight turn; `item.active`
      // brings the shimmering label in only during the gaps where no other
      // affordance owns the progress signal — it hides while assistant text
      // streams, while an inline `SingleActivity` thinking link shimmers, and
      // while a prompt is pending (see `shouldShowThinkingIndicator`). While
      // inactive the slot animates closed (h-0) instead of holding a blank
      // fixed-height band above the avatar; the height transition keeps the
      // show/hide handoff a smooth slide rather than a reflow jump. Same bare
      // avatar-tinted shimmer treatment as the inline link so the handoff
      // reads as one continuous "Thinking" state; the three-dot typing pill it
      // replaces read as a competing third loading affordance.
      return (
        <div
          data-testid="transcript-thinking-row"
          data-active={item.active ? "true" : "false"}
          aria-hidden={!item.active}
          className={`flex items-center overflow-hidden text-[13px] font-medium text-[var(--content-secondary)] transition-[height,opacity] duration-300 ease-out motion-reduce:transition-none ${
            item.active ? "h-7 opacity-100" : "h-0 opacity-0"
          }`}
        >
          <StreamingShimmerText>
            {item.label ?? "Thinking"}
          </StreamingShimmerText>
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
            <ChatMarkdownMessage
              content={item.result.text}
              hardLineBreaks
              assistantId={assistantId}
            />
          </div>
        </div>
      );

    case "onboardingChoice":
      if (renderOnboardingChoice) {
        return <>{renderOnboardingChoice()}</>;
      }
      return null;

    case "creditsUpsell": {
      // Substituted in place of a credits-exhausted provider-error row by
      // `buildTranscriptItems`. Substituted items carry the underlying row
      // (`message`) and render through `CreditsUpsellMessageRow`; the
      // proactive tail card has no backing message and renders the bare card.
      if (item.message) {
        return (
          <CreditsUpsellMessageRow
            message={item.message}
            conversationId={conversationId}
            onInspectMessage={onInspectMessage}
          />
        );
      }
      return <CreditsUpsellCard />;
    }

    default: {
      // Exhaustiveness guard — TypeScript narrows `item` to `never` here.
      const _exhaustive: never = item;
      void _exhaustive;
      return null;
    }
  }
});
