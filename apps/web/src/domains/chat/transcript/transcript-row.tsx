
import { memo, type ReactNode } from "react";

import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import type { TranscriptItem } from "@/domains/chat/transcript/types";
import { Notice } from "@vellumai/design-library";

import { PendingConfirmationRow } from "@/domains/chat/transcript/pending-confirmation-row";
import { PendingContactRequestRow } from "@/domains/chat/transcript/pending-contact-request-row";
import { PendingSecretRow } from "@/domains/chat/transcript/pending-secret-row";
import { TranscriptMessageBody } from "@/domains/chat/transcript/transcript-message-body";
import type { ConfirmationDecision } from "@/types/event-types";

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
  assistantDisplayName?: string | null;
  expandedToolCallIds: Set<string>;
  expandedCardIds: Map<string, boolean>;
  expandedThinkingKeys: Map<string, boolean>;
  onSurfaceAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
  onRetryError: () => void;
  onForkConversation?: (messageId: string) => void;
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
    riskScopeOptions: import("@/types/interaction-ui-types").RiskScopeOption[];
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
  /** Forwarded to inline app surfaces so they can render live preview iframes. */
  assistantId?: string | null;
  /** Click handler when the user clicks the "open timeline" button on an
   *  inline subagent progress card. */
  onSubagentClick?: (subagentId: string) => void;
  /** Callback to abort/stop a running subagent from an inline card. */
  onStopSubagent?: (subagentId: string) => void;
  /** True when this row belongs to the actively-streaming turn. Forwarded to
   *  `TranscriptMessageBody` so the streaming message's last tool-call group
   *  defaults open. History rows leave it `false`. */
  isStreaming?: boolean;
}

export const TranscriptRow = memo(function TranscriptRow({
  item,
  assistantDisplayName,
  expandedToolCallIds,
  expandedCardIds,
  expandedThinkingKeys,
  onSurfaceAction,
  onRetryError,
  onForkConversation,
  onInspectMessage,
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
  isStreaming,
}: TranscriptRowProps) {
  switch (item.kind) {
    case "message":
      return (
        <TranscriptMessageBody
          message={item.message}
          assistantDisplayName={assistantDisplayName}
          expandedToolCallIds={expandedToolCallIds}
          expandedCardIds={expandedCardIds}
          expandedThinkingKeys={expandedThinkingKeys}
          onSurfaceAction={onSurfaceAction}
          onForkConversation={onForkConversation}
          onInspectMessage={onInspectMessage}
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
          isStreaming={isStreaming}
        />
      );

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
      return (
        <div className="flex justify-start">
          <div className="flex items-center gap-[5px] rounded-[var(--radius-lg)] bg-[var(--surface-overlay)] px-4 py-3">
            {/* Delays produce left→right wave: dot 0 peaks at ~0.17s,
                dot 1 at ~0.5s, dot 2 at ~0.83s — matching macOS
                TypingIndicatorView phase offsets of -index × 2π/3. */}
            {([-0.333, 0, -0.667] as const).map((delay, i) => (
              <span
                key={i}
                aria-hidden
                className="typing-dot block h-2 w-2 rounded-full bg-[var(--content-tertiary)]"
                style={{
                  animation: "typing-dot-pulse 1s ease-in-out infinite",
                  animationDelay: `${delay}s`,
                }}
              />
            ))}
            {item.label ? (
              <span className="ml-1 text-body-small-default text-[var(--content-secondary)]">
                {item.label}
              </span>
            ) : (
              <span className="sr-only">Thinking…</span>
            )}
          </div>
        </div>
      );

    case "profileAutoRouted":
      return (
        <div className="flex items-center justify-center py-1 text-body-small-default text-[var(--content-tertiary)]">
          Using {item.profileLabel} for this response
        </div>
      );

    case "pendingSecret":
      return <PendingSecretRow />;

    case "pendingConfirmation":
      return <PendingConfirmationRow />;

    case "pendingContactRequest":
      return <PendingContactRequestRow />;

    case "error":
      // Mirrors the `{error && <Notice tone="error">{error}</Notice>}` from
      // AssistantPageClient.tsx. `onRetryError` is wired as the dismiss
      // handler so the user has a visible retry/ack affordance; the legacy
      // path elides the close button, which is acceptable here because the
      // error item is synthesized only after retries are exhausted.
      return (
        <Notice tone="error" onDismiss={onRetryError}>
          {item.message}
        </Notice>
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
