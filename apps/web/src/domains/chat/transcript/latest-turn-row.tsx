
import { Fragment, memo, type ReactNode } from "react";

import type { MessageItem, TranscriptItem } from "@/domains/chat/transcript/types";

import { TranscriptRow } from "@/domains/chat/transcript/transcript-row";
import type { ConfirmationDecision } from "@/types/event-types";

/**
 * Renders the newest user message (the "anchor") plus any response items that
 * have streamed in since it was sent. Sized to at least the scroll viewport
 * height so the anchor stays pinned to the top of the viewport at the latest
 * edge while short replies grow downward without hugging the bottom.
 *
 * Layout:
 *   1. Anchor user message row
 *   2. Response items
 *   3. Avatar slot
 *   4. flex-1 spacer (fills remaining viewport height below content)
 *   5. data-latest-edge sentinel
 */
export interface LatestTurnRowProps {
  anchorMessage: MessageItem;
  responseItems: TranscriptItem[];
  assistantDisplayName?: string | null;
  /** Current scroll container height — drives `minHeight`. Provided by the
   *  parent `Transcript` via `useViewportMinHeight`. */
  viewportMinHeight: number;
  expandedToolCallIds: Set<string>;
  expandedCardIds: Map<string, boolean>;
  onSurfaceAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
  onSecretSubmit: (requestId: string, value: string) => void;
  onConfirmationDecision: (requestId: string, decision: string) => void;
  onRetryError: () => void;
  onForkConversation?: (messageId: string) => void;
  onInspectMessage?: (messageId: string) => void;
  renderPendingSecret?: (requestId: string) => ReactNode;
  renderPendingConfirmation?: (requestId: string) => ReactNode;
  renderPendingContactRequest?: (requestId: string) => ReactNode;
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
  /** Whether the confirmation action is currently being submitted. */
  isSubmittingConfirmation?: boolean;
  /** Callback when the user clicks Allow or Deny on an inline confirmation. */
  onConfirmationSubmit?: (decision: ConfirmationDecision) => void;
  /** Callback when the user picks "Allow & Create Rule" from the split button. */
  onAllowAndCreateRule?: () => void;
  /** The tool call id that currently has the active pending confirmation. */
  pendingConfirmationToolCallId?: string;
  onOpenApp?: (appId: string) => void;
  onOpenDocument?: (documentSurfaceId: string) => void;
  assistantId?: string | null;
  /** Click handler when the user clicks the "open timeline" button on an
   *  inline subagent progress card. */
  onSubagentClick?: (subagentId: string) => void;
  /** Callback to abort/stop a running subagent from an inline card. */
  onStopSubagent?: (subagentId: string) => void;
  /** Slot rendered after the latest assistant response inside the
   *  latest-turn cluster. Used by AssistantPageClient (PR 3) to mount
   *  the chat avatar at the bottom of the latest assistant message
   *  rather than at the bottom of the entire chat. */
  avatarSlot?: ReactNode;
}

export const LatestTurnRow = memo(function LatestTurnRow({
  anchorMessage,
  responseItems,
  assistantDisplayName,
  viewportMinHeight,
  expandedToolCallIds,
  expandedCardIds,
  onSurfaceAction,
  onSecretSubmit,
  onConfirmationDecision,
  onRetryError,
  onForkConversation,
  onInspectMessage,
  renderPendingSecret,
  renderPendingConfirmation,
  renderPendingContactRequest,
  renderOnboardingChoice,
  onOpenRuleEditor,
  unknownNudgeToolCallIds,
  onDismissUnknownNudge,
  isSubmittingConfirmation,
  onConfirmationSubmit,
  onAllowAndCreateRule,
  pendingConfirmationToolCallId,
  onOpenApp,
  onOpenDocument,
  assistantId,
  onSubagentClick,
  onStopSubagent,
  avatarSlot,
}: LatestTurnRowProps) {
  return (
    <div
      className="flex flex-col"
      style={{ minHeight: viewportMinHeight }}
      data-latest-turn="true"
    >
      <TranscriptRow
        item={anchorMessage}
        assistantDisplayName={assistantDisplayName}
        expandedToolCallIds={expandedToolCallIds}
        expandedCardIds={expandedCardIds}
        onSurfaceAction={onSurfaceAction}
        onSecretSubmit={onSecretSubmit}
        onConfirmationDecision={onConfirmationDecision}
        onRetryError={onRetryError}
        onForkConversation={onForkConversation}
        onInspectMessage={onInspectMessage}
        renderPendingSecret={renderPendingSecret}
        renderPendingConfirmation={renderPendingConfirmation}
        renderPendingContactRequest={renderPendingContactRequest}
        renderOnboardingChoice={renderOnboardingChoice}
        onOpenRuleEditor={onOpenRuleEditor}
        unknownNudgeToolCallIds={unknownNudgeToolCallIds}
        onDismissUnknownNudge={onDismissUnknownNudge}
        isSubmittingConfirmation={isSubmittingConfirmation}
        onConfirmationSubmit={onConfirmationSubmit}
        onAllowAndCreateRule={onAllowAndCreateRule}
        pendingConfirmationToolCallId={pendingConfirmationToolCallId}
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
            assistantDisplayName={assistantDisplayName}
            expandedToolCallIds={expandedToolCallIds}
            expandedCardIds={expandedCardIds}
            onSurfaceAction={onSurfaceAction}
            onSecretSubmit={onSecretSubmit}
            onConfirmationDecision={onConfirmationDecision}
            onRetryError={onRetryError}
            onForkConversation={onForkConversation}
            onInspectMessage={onInspectMessage}
            renderPendingSecret={renderPendingSecret}
            renderPendingConfirmation={renderPendingConfirmation}
            renderPendingContactRequest={renderPendingContactRequest}
            renderOnboardingChoice={renderOnboardingChoice}
            onOpenRuleEditor={onOpenRuleEditor}
            unknownNudgeToolCallIds={unknownNudgeToolCallIds}
            onDismissUnknownNudge={onDismissUnknownNudge}
            isSubmittingConfirmation={isSubmittingConfirmation}
            onConfirmationSubmit={onConfirmationSubmit}
            onAllowAndCreateRule={onAllowAndCreateRule}
            pendingConfirmationToolCallId={pendingConfirmationToolCallId}
            onOpenApp={onOpenApp}
            onOpenDocument={onOpenDocument}
            assistantId={assistantId}
            onSubagentClick={onSubagentClick}
            onStopSubagent={onStopSubagent}
          />
        </Fragment>
      ))}
      {avatarSlot && (
        // Render whenever a slot is provided — including the "user just
        // sent, response hasn't streamed yet" gap. Gating on
        // `responseItems.length > 0` here causes the avatar to unmount
        // and remount across the turn boundary, replaying the
        // ChatAvatar entrance spring as a visible flicker. Keeping the
        // slot mounted preserves DOM identity; the avatar's already-
        // wired `isStreaming` prop drives the "thinking" beat while V
        // composes a reply.
        <div
          data-latest-assistant-avatar="true"
          className="flex justify-start pl-1 pt-3 pb-2"
        >
          {avatarSlot}
        </div>
      )}
      <div className="flex-1" />
      <div aria-hidden data-latest-edge="true" />
    </div>
  );
});
