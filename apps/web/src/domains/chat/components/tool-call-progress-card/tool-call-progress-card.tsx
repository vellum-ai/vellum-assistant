
import { AlertCircle, X } from "lucide-react";
import { Fragment, useState } from "react";

import { ToolCallChip } from "@/domains/chat/components/tool-call-chip/tool-call-chip.js";
import { FaviconChip } from "@/domains/chat/components/web-search/favicon-chip.js";
import { StepRow } from "@/domains/chat/components/web-search/step-row.js";
import { ThinkingChip } from "@/domains/chat/components/web-search/thinking-chip.js";
import { WebSearchProgressCard } from "@/domains/chat/components/web-search/web-search-progress-card.js";
import type { StepDescriptor } from "@/domains/chat/components/web-search/web-search-progress-card.js";
import { Typography } from "@vellum/design-library";

import {
  ToolProgressCardShell,
  type ToolProgressCardState,
} from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell.js";
import { ToolStepRow } from "@/domains/chat/components/tool-call-progress-card/tool-step-row.js";
import {
  useToolCallCardData,
  WEB_TOOL_NAMES,
  type ToolCallCardData,
  type ToolCallCardStep,
} from "@/domains/chat/hooks/use-tool-call-card-data.js";
import type {
  AllowlistOption,
  ChatMessageToolCall,
  ConfirmationDecision,
  DirectoryScopeOption,
  ScopeOption,
} from "@/domains/chat/api/event-types.js";

export interface ToolCallProgressCardProps {
  toolCalls: ChatMessageToolCall[];
  expandedToolCallIds: Set<string>;
  onExpandChange: (toolCallId: string, expanded: boolean) => void;
  /**
   * Persistent map of card expansion overrides. Keyed by the first tool-call
   * id in the group so the user's explicit toggle survives component remounts
   * (e.g. when items transition from latest-turn to history). `true` = user
   * explicitly expanded, `false` = user explicitly collapsed.
   */
  expandedCardIds: Map<string, boolean>;
  onOpenRuleEditor?: (context: {
    toolName: string;
    riskLevel?: string;
    riskReason?: string;
    input?: Record<string, unknown>;
    allowlistOptions: AllowlistOption[];
    scopeOptions: ScopeOption[];
    directoryScopeOptions: DirectoryScopeOption[];
  }) => void;
  // Inline confirmation props (pass-through)
  isSubmittingConfirmation?: boolean;
  onConfirmationSubmit?: (decision: ConfirmationDecision) => void;
  onAllowAndCreateRule?: () => void;
  pendingConfirmationToolCallId?: string;
  // Unknown nudge props (pass-through)
  unknownNudgeToolCallIds?: Set<string>;
  onDismissUnknownNudge?: (toolCallId: string) => void;
  /**
   * Whether the parent assistant message is currently streaming a response.
   * Retained for API compatibility with the legacy dispatcher; the unified
   * card derives its visual state from `useToolCallCardData` instead.
   */
  isStreaming?: boolean;
  /**
   * Optional leading "thinking" text segment that immediately preceded this
   * tool-call group in the message's `contentOrder`. When supplied the
   * unified card prepends a `thinking` step to the expanded body so the
   * carousel shows the model's reasoning before the first tool fires.
   */
  leadingThinkingText?: string | null;
}

/**
 * Unified tool-call progress card. All tool groups — web search, bash, file
 * ops, MCP, computer use, skills — render through the shared
 * {@link ToolProgressCardShell} driven by {@link useToolCallCardData}.
 *
 * Special cases short-circuit before the shell:
 *
 * - `pendingConfirmationToolCallId` matches a tool call in this group →
 *   render the inline confirmation UI via {@link ToolCallChip} so the
 *   approve/deny path is preserved bit-for-bit from the legacy card.
 * - `subagent_spawn`-only group → return `null` until PR 8 wires the inline
 *   subagent card; the legacy bottom-of-message `SubagentProgressCard`
 *   continues to render the spawned subagent's progress.
 */
export function ToolCallProgressCard(props: ToolCallProgressCardProps) {
  const {
    toolCalls,
    pendingConfirmationToolCallId,
    leadingThinkingText,
  } = props;

  const hasActiveConfirmation =
    pendingConfirmationToolCallId != null &&
    toolCalls.some((tc) => tc.id === pendingConfirmationToolCallId);

  // Single subscription to the unified hook so the dispatcher and every
  // downstream branch share the same projection. `leadingThinkingText`
  // prepends a `thinking` step ahead of the first tool call when supplied;
  // purely-web groups (which historically didn't have a leading-thinking
  // slot) typically pass `null` so the prepend is a no-op.
  const cardData = useToolCallCardData(
    toolCalls,
    leadingThinkingText ?? null,
  );

  // Confirmation short-circuit — render the inline approve/deny UI via the
  // existing chip-based rendering. Bypasses the progress-card chrome
  // entirely so the confirmation card sits flush in the transcript and the
  // user can act on it without first expanding a collapsed card.
  if (hasActiveConfirmation) {
    return <ConfirmationView {...props} />;
  }

  // Subagent-only group — PR 7 introduces an inline subagent card; until
  // then the spawned subagent continues to render via the legacy bottom-of-
  // message `SubagentProgressCard`, so this card returns nothing.
  if (
    toolCalls.length === 1 &&
    toolCalls[0]?.toolName === "subagent_spawn"
  ) {
    return null;
  }

  // Purely-web groups continue to flow through `WebSearchProgressCard` for
  // its mature rendering (carousel header, error chips). Mixed / non-web
  // groups fall through to the unified shell below.
  if (isPurelyWebGroup(toolCalls)) {
    return <WebSearchView toolCalls={toolCalls} cardData={cardData} />;
  }

  return <UnifiedToolCallProgressCard {...props} cardData={cardData} />;
}

/**
 * True when every tool call in the group is a web tool (`web_search` /
 * `web_fetch`). Matches the legacy `useWebSearchCardData` predicate.
 */
function isPurelyWebGroup(toolCalls: ChatMessageToolCall[]): boolean {
  if (toolCalls.length === 0) return false;
  return toolCalls.every((tc) => WEB_TOOL_NAMES.has(tc.toolName));
}

/**
 * Renders the web-search variant by narrowing the unified card data to the
 * legacy `WebSearchProgressCard` props. State is recomputed from the raw
 * tool-call statuses rather than the unified `state` because a denied
 * confirmation can race ahead of the error `tool_result` and the legacy
 * card has to stay in `"loading"` until the tool actually exits.
 */
function WebSearchView({
  toolCalls,
  cardData,
}: {
  toolCalls: ChatMessageToolCall[];
  cardData: ToolCallCardData;
}) {
  const state: "loading" | "complete" = toolCalls.some(
    (tc) => tc.status === "running",
  )
    ? "loading"
    : "complete";
  return (
    <WebSearchProgressCard
      currentStepTitle={cardData.currentStepTitle}
      currentStepInfo={cardData.currentStepInfo}
      stepCount={cardData.stepCount}
      // Every step in a purely-web group is one of the legacy three kinds
      // by construction — the `tool` variant only appears for non-web
      // tools, which this branch filters out.
      steps={cardData.steps as StepDescriptor[]}
      state={state}
      carouselItems={cardData.carouselItems}
    />
  );
}

/**
 * Render the unified shell for a non-web tool-call group. Wraps
 * `ToolProgressCardShell` with the step-row body that mixes
 * `web_search` / `web_search_error` / `thinking` (from web tools or the
 * `leadingThinkingText` slot) with the new `tool` variant emitted by
 * `useToolCallCardData` for non-web tools.
 */
function UnifiedToolCallProgressCard({
  toolCalls,
  expandedCardIds,
  cardData,
  onOpenRuleEditor,
  unknownNudgeToolCallIds,
  onDismissUnknownNudge,
}: ToolCallProgressCardProps & { cardData: ToolCallCardData }) {
  const cardId = toolCalls[0]?.id ?? null;
  const expanded = useCardExpanded(cardId, cardData.state, expandedCardIds);

  const shellState: ToolProgressCardState = cardData.state;

  // Nudge rows need the raw call (riskLevel, allowlistOptions, …) which
  // isn't carried on the step descriptor.
  const toolCallById = new Map(toolCalls.map((tc) => [tc.id, tc]));

  return (
    <ToolProgressCardShell
      state={shellState}
      currentStepTitle={cardData.currentStepTitle}
      currentStepInfo={cardData.currentStepInfo}
      stepCount={cardData.stepCount}
      expanded={expanded.value}
      onExpandChange={expanded.onChange}
    >
      <div className="flex w-full flex-col gap-3 px-3 pb-3">
        {cardData.steps.map((step, idx) => {
          const nudgeTarget =
            step.kind === "tool" &&
            unknownNudgeToolCallIds?.has(step.toolCallId)
              ? toolCallById.get(step.toolCallId)
              : undefined;
          return (
            <Fragment key={stepKey(step, idx)}>
              <ExpandedStep step={step} />
              {nudgeTarget && onOpenRuleEditor && (
                <UnknownCommandNudge
                  toolCall={nudgeTarget}
                  onOpenRuleEditor={onOpenRuleEditor}
                  onDismiss={onDismissUnknownNudge}
                />
              )}
            </Fragment>
          );
        })}
      </div>
    </ToolProgressCardShell>
  );
}

/**
 * Drives the unified card's expand/collapse state. Mirrors legacy behavior:
 * auto-expand while loading, auto-collapse on terminal state, but a user
 * toggle (now or in a previous mount, recorded in `expandedCardIds`) wins
 * across state transitions and remounts.
 *
 * `localToggle` mirrors the map mutation so React re-renders on click —
 * mutating the map alone wouldn't trigger one.
 */
function useCardExpanded(
  cardId: string | null,
  state: ToolCallCardData["state"],
  expandedCardIds: Map<string, boolean>,
): { value: boolean; onChange: (next: boolean) => void } {
  const [localToggle, setLocalToggle] = useState<boolean | undefined>(
    undefined,
  );
  const persisted =
    cardId != null ? expandedCardIds.get(cardId) : undefined;
  const userChoice = localToggle ?? persisted;
  const value = userChoice ?? state === "loading";

  const onChange = (next: boolean) => {
    setLocalToggle(next);
    if (cardId != null) expandedCardIds.set(cardId, next);
  };

  return { value, onChange };
}

/**
 * Inline "This command wasn't recognized." nudge rendered beneath a tool
 * step whose call is flagged in `unknownNudgeToolCallIds`. Restores the
 * legacy affordance one-for-one — same copy, same "Create a rule" link, same
 * dismiss-X button.
 */
function UnknownCommandNudge({
  toolCall,
  onOpenRuleEditor,
  onDismiss,
}: {
  toolCall: ChatMessageToolCall;
  onOpenRuleEditor: NonNullable<ToolCallProgressCardProps["onOpenRuleEditor"]>;
  onDismiss?: ToolCallProgressCardProps["onDismissUnknownNudge"];
}) {
  return (
    <div className="flex items-center gap-1 pl-6 text-body-small-default text-[var(--content-tertiary)]">
      <span>This command wasn&apos;t recognized.</span>
      <button
        type="button"
        onClick={() =>
          onOpenRuleEditor({
            toolName: toolCall.toolName,
            riskLevel: toolCall.riskLevel,
            riskReason: toolCall.riskReason,
            input: toolCall.input ?? {},
            allowlistOptions: toolCall.allowlistOptions ?? [],
            scopeOptions: toolCall.scopeOptions ?? [],
            directoryScopeOptions: toolCall.directoryScopeOptions ?? [],
          })
        }
        // typography: off-scale — inline link within body-small nudge
        className="font-medium text-[var(--content-default)] underline underline-offset-2 hover:text-[var(--content-secondary)]"
      >
        Create a rule
      </button>
      <span>to classify it for next time.</span>
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => onDismiss(toolCall.id)}
          className="ml-1 text-[var(--content-disabled)] hover:text-[var(--content-tertiary)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * Stable key for a step descriptor. The `tool` variant ties back to a
 * specific tool call id; the rest of the variants are positional.
 */
function stepKey(step: ToolCallCardStep, idx: number): string {
  if (step.kind === "tool") return step.toolCallId;
  return `${step.kind}-${idx}`;
}

/**
 * Render a single step inside the expanded body. The `web_search` /
 * `web_search_error` / `thinking` variants reuse the chips from
 * `WebSearchProgressCard` so the visual language stays consistent between
 * web and mixed groups; the `tool` variant uses the new `ToolStepRow`.
 */
function ExpandedStep({ step }: { step: ToolCallCardStep }) {
  if (step.kind === "thinking") {
    return (
      <StepRow title="Thinking" durationLabel={step.durationLabel}>
        <ThinkingChip>{step.text}</ThinkingChip>
      </StepRow>
    );
  }
  if (step.kind === "web_search_error") {
    return (
      <StepRow
        title={step.title}
        durationLabel={step.durationLabel}
        tone="error"
      >
        <ErrorChip message={step.errorMessage} />
      </StepRow>
    );
  }
  if (step.kind === "web_search") {
    return (
      <StepRow
        title={step.title}
        durationLabel={step.durationLabel}
        linkCount={step.linkCount}
      >
        {step.results.map((r) => (
          <FaviconChip
            key={r.rank}
            faviconUrl={r.faviconUrl}
            title={r.title}
            domain={r.domain}
          />
        ))}
        {step.overflow && step.overflow > 0 ? (
          <OverflowChip count={step.overflow} />
        ) : null}
      </StepRow>
    );
  }
  return (
    <ToolStepRow
      title={step.title}
      info={step.info}
      iconName={step.iconName}
      status={step.status}
      durationLabel={step.durationLabel}
    />
  );
}

// ---------------------------------------------------------------------------
// Confirmation view — preserved bit-for-bit from the legacy card
// ---------------------------------------------------------------------------

/**
 * Inline approve/deny UI for a group that contains an active permission
 * prompt. Renders each tool call as an embedded `ToolCallChip` (the chip
 * itself owns the `InlineConfirmationCard` mounting for the matching call).
 *
 * Kept structurally identical to the legacy card's confirmation branch so
 * existing tests, screenshots, and keyboard flows stay unchanged.
 */
function ConfirmationView({
  toolCalls,
  expandedToolCallIds,
  onExpandChange,
  onOpenRuleEditor,
  isSubmittingConfirmation,
  onConfirmationSubmit,
  onAllowAndCreateRule,
  pendingConfirmationToolCallId,
  unknownNudgeToolCallIds,
  onDismissUnknownNudge,
}: ToolCallProgressCardProps) {
  return (
    <div className="my-1 w-full">
      <div className="space-y-0 rounded-lg bg-[var(--surface-overlay)]">
        {toolCalls.map((tc) => {
          const isConfirmationTarget =
            tc.id === pendingConfirmationToolCallId;
          return (
            <Fragment key={tc.id}>
              <ToolCallChip
                toolCall={tc}
                defaultExpanded={expandedToolCallIds.has(tc.id)}
                onExpandChange={(isExpanded) =>
                  onExpandChange(tc.id, isExpanded)
                }
                onOpenRuleEditor={onOpenRuleEditor}
                embedded
                {...(isConfirmationTarget
                  ? {
                      isSubmittingConfirmation,
                      isActiveConfirmation: true,
                      onConfirmationSubmit,
                      onAllowAndCreateRule,
                    }
                  : {})}
              />
              {unknownNudgeToolCallIds?.has(tc.id) && onOpenRuleEditor && (
                <UnknownCommandNudge
                  toolCall={tc}
                  onOpenRuleEditor={onOpenRuleEditor}
                  onDismiss={onDismissUnknownNudge}
                />
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small shared chips — kept local so the file is self-contained
// ---------------------------------------------------------------------------

function OverflowChip({ count }: { count: number }) {
  return (
    <div className="rounded-[var(--radius-pill)] bg-[var(--surface-base)] px-[10px] py-[6px]">
      <Typography
        variant="body-small-emphasised"
        className="text-[var(--content-default)]"
      >
        +{count} more
      </Typography>
    </div>
  );
}

function ErrorChip({ message }: { message: string }) {
  return (
    <div
      data-testid="tool-progress-error-chip"
      className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] border border-[var(--system-negative-weak)] bg-[var(--system-negative-weak)] px-[10px] py-[6px]"
    >
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
        <AlertCircle className="h-[14px] w-[14px] text-[var(--system-negative-strong)]" />
      </span>
      <Typography
        variant="body-small-default"
        className="text-[var(--system-negative-strong)]"
      >
        {message}
      </Typography>
    </div>
  );
}
