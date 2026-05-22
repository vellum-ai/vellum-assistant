
import { Loader2 } from "lucide-react";
import { memo, type ReactNode } from "react";

import { Notice } from "@vellum/design-library";
import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router.js";
import type { TranscriptItem } from "@/domains/chat/transcript/types.js";

import { TranscriptMessageBody } from "@/domains/chat/transcript/transcript-message-body.js";
import type { ConfirmationDecision } from "@/domains/chat/api/event-types.js";

/**
 * Thin dispatcher: render one `TranscriptItem` using the matching existing
 * component for its `kind`. Never forks the component — the per-kind JSX
 * mirrors the corresponding block in `AssistantPageClient.tsx`.
 *
 * `renderPendingSecret` / `renderPendingConfirmation` are render-prop slots:
 * the pending-prompt cards (`SecretPromptCard`, `ConfirmationPromptCard`)
 * currently live inside `AssistantPageClient.tsx` and depend on local state
 * (submitting, saved, etc). PR 7 passes those renderers in; until then we
 * fall back to a minimal built-in prompt that exercises the public callbacks
 * so the Transcript still produces something sensible in isolation.
 */
export interface TranscriptRowProps {
  item: TranscriptItem;
  assistantDisplayName?: string | null;
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
  /** Render-prop override for `kind: "pendingSecret"`. */
  renderPendingSecret?: (requestId: string) => ReactNode;
  /** Render-prop override for `kind: "pendingConfirmation"`. */
  renderPendingConfirmation?: (requestId: string) => ReactNode;
  /** Render-prop override for `kind: "pendingContactRequest"`. */
  renderPendingContactRequest?: (requestId: string) => ReactNode;
  /** Render-prop override for `kind: "onboardingChoice"`. */
  renderOnboardingChoice?: () => ReactNode;
  onOpenRuleEditor?: (context: {
    toolName: string;
    riskLevel?: string;
    riskReason?: string;
    input?: Record<string, unknown>;
    allowlistOptions: import("@/domains/chat/api/event-types.js").AllowlistOption[];
    scopeOptions: import("@/domains/chat/api/event-types.js").ScopeOption[];
    directoryScopeOptions: import("@/domains/chat/api/event-types.js").DirectoryScopeOption[];
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
}

export const TranscriptRow = memo(function TranscriptRow({
  item,
  assistantDisplayName,
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
}: TranscriptRowProps) {
  switch (item.kind) {
    case "message":
      return (
        <TranscriptMessageBody
          message={item.message}
          assistantDisplayName={assistantDisplayName}
          expandedToolCallIds={expandedToolCallIds}
          expandedCardIds={expandedCardIds}
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
      if (renderPendingSecret) {
        return <>{renderPendingSecret(item.requestId)}</>;
      }
      return (
        <MinimalSecretPrompt
          requestId={item.requestId}
          onSubmit={onSecretSubmit}
        />
      );

    case "pendingConfirmation":
      if (renderPendingConfirmation) {
        return <>{renderPendingConfirmation(item.requestId)}</>;
      }
      return (
        <MinimalConfirmationPrompt
          requestId={item.requestId}
          onDecision={onConfirmationDecision}
        />
      );

    case "pendingContactRequest":
      if (renderPendingContactRequest) {
        return <>{renderPendingContactRequest(item.requestId)}</>;
      }
      // Minimal fallback — full UI provided via renderPendingContactRequest in AssistantPageClient.
      return (
        // typography: off-scale — compact card fallback, not prose
         
        <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--surface-secondary)] p-4 text-sm text-[var(--content-secondary)]">
          {item.label ?? "Enter contact info"}
        </div>
      );

    case "queuedMarker":
      return (
        <div className="flex items-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-sunken)] px-3 py-2 text-body-small-default text-[var(--content-tertiary)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {item.count === 1
            ? "1 message queued"
            : `${item.count} messages queued`}
        </div>
      );

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

// ---------------------------------------------------------------------------
// Minimal built-in prompts. These are intentionally bare-bones — PR 7 passes
// the real `SecretPromptCard` / `ConfirmationPromptCard` via render props.
// ---------------------------------------------------------------------------

function MinimalSecretPrompt({
  requestId,
  onSubmit,
}: {
  requestId: string;
  onSubmit: (requestId: string, value: string) => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const input = form.elements.namedItem("secret");
        if (input instanceof HTMLInputElement) {
          onSubmit(requestId, input.value);
        }
      }}
      className="flex items-center gap-2 rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] p-3"
    >
      <input
        type="password"
        name="secret"
        // typography: off-scale — minimal stub for isolated rendering; production uses renderPendingSecret slot
         
        className="flex-1 rounded-md border border-[var(--border-base)] bg-white px-2 py-1 text-sm"
      />
      <button
        type="submit"
        // typography: off-scale — minimal stub for isolated rendering; production uses renderPendingSecret slot
         
        className="rounded-md bg-[var(--primary-base)] px-3 py-1 text-sm font-medium text-[var(--content-inset)]"
      >
        Save
      </button>
    </form>
  );
}

function MinimalConfirmationPrompt({
  requestId,
  onDecision,
}: {
  requestId: string;
  onDecision: (requestId: string, decision: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] p-3">
      <button
        type="button"
        onClick={() => onDecision(requestId, "allow")}
        // typography: off-scale — minimal stub for isolated rendering; production uses renderPendingConfirmation slot
         
        className="rounded-md bg-[var(--system-positive-strong)] px-3 py-1 text-sm font-medium text-white"
      >
        Allow
      </button>
      <button
        type="button"
        onClick={() => onDecision(requestId, "deny")}
        // typography: off-scale — minimal stub for isolated rendering; production uses renderPendingConfirmation slot
         
        className="rounded-md border border-[var(--system-negative-strong)] px-3 py-1 text-sm font-medium text-[var(--system-negative-strong)]"
      >
        Deny
      </button>
    </div>
  );
}
