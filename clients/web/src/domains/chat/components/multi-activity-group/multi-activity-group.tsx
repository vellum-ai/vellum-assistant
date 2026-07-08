import { Brain, X } from "lucide-react";
import { Fragment, useCallback, useMemo } from "react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";

import { Typography } from "@vellumai/design-library";

import { ToolCallChip } from "@/domains/chat/components/tool-call-chip/tool-call-chip";
import { SingleActivity } from "@/domains/chat/components/single-activity/single-activity";
import {
  ToolProgressCardShell,
  type ToolProgressCardState,
} from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell";
import {
  sameActivityStepsTarget,
  useViewerStore,
  type ActivityStepsPayload,
} from "@/stores/viewer-store";
import {
  type ToolCallCardData,
  type ToolCallCardItem,
  type ToolCallCardStep,
} from "@/domains/chat/utils/tool-call-card-utils";
import { useToolCallCardDataFromItems } from "@/domains/chat/hooks/use-tool-call-card-data";
import type { ConfirmationDecision } from "@/types/event-types";
import type { AllowlistOption, DirectoryScopeOption, ScopeOption } from "@/types/interaction-ui-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { truncate } from "@/domains/chat/utils/truncate";
import { isToolCallRunning } from "@/domains/chat/utils/tool-call-status";

/**
 * Hard character cap for the thinking text shown in the collapsed header's
 * carousel info slot. The header concatenates the reasoning text with an
 * ellipsis so a long thinking segment doesn't fill the row and collide with
 * the step-count pill. CSS `truncate` is the responsive safety net; this cap
 * makes it concatenate sooner.
 */
const HEADER_INFO_MAX_CHARS = 80;

export interface MultiActivityGroupProps {
  toolCalls: ChatMessageToolCall[];
  onOpenRuleEditor?: (context: {
    toolName: string;
    riskLevel?: string;
    riskReason?: string;
    input?: Record<string, unknown>;
    allowlistOptions: AllowlistOption[];
    scopeOptions: ScopeOption[];
    directoryScopeOptions: DirectoryScopeOption[];
    matchedTrustRuleId?: string;
  }) => void;
  // Inline confirmation props (pass-through). Each chip renders its own card
  // from `tc.pendingConfirmation`, so the handlers receive the originating
  // tool call rather than relying on a single "active" id.
  onConfirmationSubmit?: (
    decision: ConfirmationDecision,
    toolCall: ChatMessageToolCall,
  ) => void | Promise<void>;
  onAllowAndCreateRule?: (toolCall: ChatMessageToolCall) => void | Promise<void>;
  // Unknown nudge props (pass-through)
  unknownNudgeToolCallIds?: Set<string>;
  onDismissUnknownNudge?: (toolCallId: string) => void;
  /**
   * Identity of the owning message + this group's index in
   * `groupContentBlocks`. Carried into the activity-steps panel payload so
   * the open panel re-derives the group's live items (via
   * `useLiveActivityGroup`) instead of freezing the snapshot.
   */
  messageId?: string;
  groupIndex?: number;
  /**
   * Ordered (thinking | toolCall) items driving the steps timeline. When
   * supplied, the group interleaves thinking steps between tool steps in the
   * given order instead of prepending a single leading-thinking step. The
   * activity-summary merged-card path passes this so a
   * `thinking → tool → thinking` run renders all three steps in order.
   *
   * `toolCalls` is still used for confirmation / purely-web detection and the
   * raw-call lookup map, so callers pass the group's tool calls there AND the
   * ordered list here.
   */
  items?: ToolCallCardItem[];
}

/**
 * Default ordered items for the legacy `(toolCalls)` callers: one `toolCall`
 * item per tool call. Mirrors the delegate in `computeToolCallCardData` so the
 * single-hook path produces identical output to the legacy projection.
 */
function buildDefaultItems(
  toolCalls: ChatMessageToolCall[],
): ToolCallCardItem[] {
  return toolCalls.map((tc) => ({ kind: "toolCall", toolCall: tc }));
}

/**
 * Tally of how many terminal, non-thinking steps a run produced and how many
 * of those failed. Thinking steps are excluded — they carry no success/failure
 * semantics — so a `thinking → failed-bash` run reads as "every tool failed",
 * not "half failed". Shared with the activity-steps panel's summary header.
 */
export function countStepOutcomes(steps: ToolCallCardStep[]): {
  total: number;
  failed: number;
} {
  let total = 0;
  let failed = 0;
  for (const step of steps) {
    if (step.kind === "thinking") {
      continue;
    }
    total += 1;
    if (
      step.kind === "tool_error" ||
      step.kind === "web_search_error" ||
      (step.kind === "tool" &&
        (step.status === "error" || step.status === "denied"))
    ) {
      failed += 1;
    }
  }
  return { total, failed };
}

/**
 * Collapse the card's base state plus the per-step failure tally into the
 * summary chrome shown on the header status icon:
 *
 * - every tool succeeded → `complete` (green check)
 * - some — but not all — tools failed → `warning` (amber triangle); the run
 *   still produced useful work, so a full red error overstates it
 * - every tool failed → `error` (red); a true failure
 *
 * `loading` always wins while anything is still running. Thinking steps never
 * count toward the tally (see {@link countStepOutcomes}). Shared with the
 * activity-steps panel.
 */
export function deriveSummaryState(
  baseState: ToolCallCardData["state"],
  steps: ToolCallCardStep[],
): ToolProgressCardState {
  if (baseState === "loading" || baseState === "complete") {
    return baseState;
  }
  // baseState is `error` / `denied` → at least one failure is present.
  const { total, failed } = countStepOutcomes(steps);
  if (failed > 0 && failed < total) {
    return "warning";
  }
  return "error";
}

/**
 * Summary label for a whole activity run, used as the activity-steps panel's
 * header title.
 *
 * Whenever we have timing data the summary reports how long the agent worked —
 * a live, ticking "Working for 16s" while running and a final "Worked for 16s"
 * once terminal, regardless of outcome (the status chrome still carries
 * success / partial / failure). Without timing data it falls back to an
 * outcome label, and the `warning` fallback spells out how many tools failed.
 */
export function activityRunSummaryLabel(
  state: ToolProgressCardState,
  totalDurationLabel: string,
  failedCount: number,
): string {
  // While running, surface the live, ticking total ("Working for 12s") once we
  // have at least a full second of work — below that the `<1s` label reads
  // awkwardly, so we keep the bare "Working".
  if (state === "loading") {
    return totalDurationLabel && totalDurationLabel !== "<1s"
      ? `Working for ${totalDurationLabel}`
      : "Working";
  }
  if (totalDurationLabel) {
    return `Worked for ${totalDurationLabel}`;
  }
  switch (state) {
    case "warning":
      return `${failedCount} ${failedCount === 1 ? "tool" : "tools"} failed`;
    case "error":
    case "denied":
      return "Failed";
    case "complete":
    default:
      return "Completed";
  }
}

/**
 * Multi-activity group. Renders a contiguous run of interleaved thinking + tool
 * steps as a single inline header — the multi-step counterpart to the lone
 * `SingleActivity` link. Clicking the header opens the group's full steps
 * timeline in the activity-steps side panel (see `ActivityStepsPanel`);
 * clicking it again closes the panel (toggle).
 *
 * Special cases short-circuit before the header:
 *
 * - a LONE `web_search` call → render the inline, expand-in-place
 *   `SingleActivity variant="web"` link. Lone `web_fetch`, grouped (2+)
 *   web, and mixed groups fall through to the unified header.
 * - any tool call in this group carries a `pendingConfirmation` → render the
 *   inline confirmation UI via {@link ToolCallChip} so the approve/deny path
 *   is preserved bit-for-bit from the legacy card.
 * - Zero renderable steps (today: a group made up entirely of
 *   `subagent_spawn` calls, which `useToolCallCardData` filters out) → render
 *   `null`; the spawned subagents render as inline `InlineProcessCard`s (via the
 *   subagent descriptor) elsewhere in the transcript.
 */
export function MultiActivityGroup(props: MultiActivityGroupProps) {
  const { toolCalls } = props;

  const hasActiveConfirmation = toolCalls.some(
    (tc) => !!tc.pendingConfirmation,
  );

  // Both downstream branches share the same projection. When the caller
  // supplies ordered `items` (the activity-summary merged-card path) those
  // drive the steps directly; otherwise we synthesize one item per tool call.
  // Computed once via a single hook call so there are no conditional hooks.
  //
  // `subagent_spawn` calls are filtered out inside the projection — they're
  // rendered inline by `InlineProcessCard` (via the subagent descriptor) at the
  // transcript level. If a group reduces to zero renderable steps the
  // dispatcher falls through to a no-op below.
  const effectiveItems = useMemo(
    () => props.items ?? buildDefaultItems(toolCalls),
    [props.items, toolCalls],
  );
  const cardData = useToolCallCardDataFromItems(effectiveItems);
  const cardId = toolCalls[0]?.id ?? null;
  const expanded = useCardExpanded(cardId);

  // Confirmation short-circuit — render the inline approve/deny UI via the
  // existing chip-based rendering. Bypasses the progress-card chrome
  // entirely so the confirmation card sits flush in the transcript and the
  // user can act on it without first expanding a collapsed card.
  if (hasActiveConfirmation) {
    return <ConfirmationView {...props} />;
  }

  // No renderable steps — every tool call in the group was filtered out
  // (today that means a `subagent_spawn`-only group). Inline subagent cards
  // handle the rendering elsewhere, so we return nothing here.
  if (cardData.steps.length === 0) {
    return null;
  }

  // A LONE web_search call renders as the inline, expand-in-place
  // `SingleActivity variant="web"` link. Lone web_fetch, grouped (2+) web, and
  // mixed groups fall through to the unified header below.
  if (toolCalls.length === 1 && toolCalls[0]!.name === "web_search") {
    return (
      <LoneWebSearch
        toolCalls={toolCalls}
        cardData={cardData}
        expanded={expanded.value}
        onExpandChange={expanded.onChange}
      />
    );
  }

  return (
    <UnifiedMultiActivityGroup
      {...props}
      cardData={cardData}
      effectiveItems={effectiveItems}
    />
  );
}

/**
 * Renders a LONE web_search call as the inline, expand-in-place
 * `SingleActivity variant="web"` link.
 *
 * Extracts the web step from `cardData.steps` via type-safe narrowing
 * (never an unsafe `as` cast). When no web step is available yet (the
 * brief loading window before metadata arrives), `step` is `null` and the
 * expanded body renders empty while the header communicates loading state.
 */
function LoneWebSearch({
  toolCalls,
  cardData,
  expanded,
  onExpandChange,
}: {
  toolCalls: ChatMessageToolCall[];
  cardData: ToolCallCardData;
  expanded: boolean;
  onExpandChange: (next: boolean) => void;
}) {
  const running = toolCalls.some((tc) => isToolCallRunning(tc));
  const state = running
    ? "loading"
    : cardData.state === "error" || cardData.state === "denied"
      ? "error"
      : "complete";
  const webStep =
    cardData.steps.find(
      (
        s,
      ): s is Extract<
        ToolCallCardStep,
        { kind: "web_search" | "web_search_error" }
      > => s.kind === "web_search" || s.kind === "web_search_error",
    ) ?? null;
  return (
    <SingleActivity
      variant="web"
      info={cardData.currentStepInfo}
      carouselItems={cardData.carouselItems}
      state={state}
      step={webStep}
      expanded={expanded}
      onExpandChange={onExpandChange}
    />
  );
}

/**
 * Render the unified header for a non-web tool-call group: an inline,
 * left-aligned row (live step carousel + step-count pill) that TOGGLES the
 * activity-steps side panel. The full phase-grouped timeline lives in that
 * panel (`ActivityStepsPanel`); the header itself has no expandable body.
 */
function UnifiedMultiActivityGroup({
  toolCalls,
  cardData,
  effectiveItems,
  onOpenRuleEditor,
  unknownNudgeToolCallIds,
  onDismissUnknownNudge,
  messageId,
  groupIndex,
}: MultiActivityGroupProps & {
  cardData: ToolCallCardData;
  effectiveItems: ToolCallCardItem[];
}) {
  const toggleActivitySteps = useViewerStore.use.toggleActivitySteps();
  const mainView = useViewerStore.use.mainView();
  const activeActivitySteps = useViewerStore.use.activeActivitySteps();

  // A partial failure (some tools failed, some succeeded) reads as an amber
  // `warning` rather than a full red `error`; an all-failed run stays `error`.
  const shellState: ToolProgressCardState = deriveSummaryState(
    cardData.state,
    cardData.steps,
  );

  const payload: ActivityStepsPayload = useMemo(
    () => ({
      messageId,
      groupIndex,
      items: effectiveItems,
      toolCalls,
    }),
    [messageId, groupIndex, effectiveItems, toolCalls],
  );

  // The header whose steps panel is currently open renders with the persistent
  // active surface, mirroring the inline links' selected state.
  const headerActive =
    mainView === "activity-steps" &&
    activeActivitySteps != null &&
    sameActivityStepsTarget(activeActivitySteps, payload);

  // When the latest step is a thinking segment, the header pairs a brain
  // glyph with the thinking text. Memoized so the carousel (which compares
  // the info node by reference via `Object.is`) doesn't re-animate on every
  // parent render — only when the (kind, info) tuple actually changes.
  const headerInfo = useMemo(() => {
    if (cardData.currentStepKind === "thinking") {
      return (
        // Fill the carousel's flex slot (`flex w-full min-w-0`) so the inner
        // text truncates inside the available width and never overflows into
        // the step-count pill. Left-aligned + hard-capped to mirror the
        // thinking step pill's concatenation.
        <span className="flex w-full min-w-0 items-center gap-1">
          <Brain
            aria-hidden="true"
            className="size-3.5 shrink-0 text-[var(--content-tertiary)]"
          />
          <Typography
            variant="body-small-default"
            className="min-w-0 flex-1 truncate text-left leading-[16px] text-[var(--content-tertiary)]"
          >
            {truncate(cardData.currentStepInfo, HEADER_INFO_MAX_CHARS)}
          </Typography>
        </span>
      );
    }
    return cardData.currentStepInfo;
  }, [cardData.currentStepKind, cardData.currentStepInfo]);

  // Nudge rows need the raw call (riskLevel, allowlistOptions, …) which isn't
  // carried on the step descriptor.
  const nudgeTargets =
    unknownNudgeToolCallIds && onOpenRuleEditor
      ? toolCalls.filter((tc) => unknownNudgeToolCallIds.has(tc.id))
      : [];

  return (
    <div className="flex w-full flex-col gap-1">
      <ToolProgressCardShell
        // The unified activity header renders bare — it flows inline on the
        // chat background like the lone `SingleActivity` link, with a ghost
        // hover on the row instead of boxed card chrome.
        bare
        state={shellState}
        currentStepTitle={cardData.currentStepTitle}
        currentStepInfo={headerInfo}
        stepCount={cardData.stepCount}
        // Clicking anywhere on the header toggles the steps side panel — the
        // timeline no longer expands in place beneath the header.
        onHeaderClick={() => toggleActivitySteps(payload)}
        headerAriaLabel="View steps"
        headerActive={headerActive}
      />
      {nudgeTargets.map((tc) => (
        <UnknownCommandNudge
          key={tc.id}
          toolCall={tc}
          onOpenRuleEditor={onOpenRuleEditor!}
          onDismiss={onDismissUnknownNudge}
        />
      ))}
    </div>
  );
}

/**
 * Drives the lone web-search link's expand/collapse state, persisted in
 * `expandedCardIds` in the session store so a user toggle survives remounts
 * (e.g. the transcript remount when a side panel opens).
 *
 * Subscribes reactively via a Zustand selector — the store action produces a
 * new Map instance on toggle, so this component re-renders without needing a
 * local useState mirror.
 */
function useCardExpanded(cardId: string | null): {
  value: boolean;
  onChange: (next: boolean) => void;
} {
  const persisted = useChatSessionStore(
    (s) => (cardId != null ? s.expandedCardIds.get(cardId) : undefined),
  );
  const value = persisted ?? false;

  const onChange = useCallback(
    (next: boolean) => {
      if (cardId != null) {
        useChatSessionStore.getState().setExpandedCardId(cardId, next);
      }
    },
    [cardId],
  );

  return { value, onChange };
}

/**
 * Inline "This command wasn't recognized." nudge rendered beneath the group
 * header for a tool call flagged in `unknownNudgeToolCallIds`. Same copy,
 * same "Create a rule" link, same dismiss-X button as the confirmation view's
 * nudge.
 */
function UnknownCommandNudge({
  toolCall,
  onOpenRuleEditor,
  onDismiss,
}: {
  toolCall: ChatMessageToolCall;
  onOpenRuleEditor: NonNullable<MultiActivityGroupProps["onOpenRuleEditor"]>;
  onDismiss?: MultiActivityGroupProps["onDismissUnknownNudge"];
}) {
  return (
    <div className="flex items-center gap-1 pl-6 text-body-small-default text-[var(--content-tertiary)]">
      <span>This command wasn&apos;t recognized.</span>
      <button
        type="button"
        onClick={() =>
          onOpenRuleEditor({
            toolName: toolCall.name,
            riskLevel: toolCall.riskLevel,
            riskReason: toolCall.riskReason,
            input: toolCall.input ?? {},
            allowlistOptions: toolCall.riskAllowlistOptions ?? [],
            scopeOptions: toolCall.scopeOptions ?? [],
            directoryScopeOptions: toolCall.riskDirectoryScopeOptions ?? [],
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
  onOpenRuleEditor,
  onConfirmationSubmit,
  onAllowAndCreateRule,
  unknownNudgeToolCallIds,
  onDismissUnknownNudge,
}: MultiActivityGroupProps) {
  return (
    <div className="my-1 w-full">
      <div className="space-y-0 rounded-lg bg-[var(--surface-overlay)]">
        {toolCalls.map((tc) => {
          const isConfirmationTarget = !!tc.pendingConfirmation;
          return (
            <Fragment key={tc.id}>
              <ToolCallChip
                toolCall={tc}
                onOpenRuleEditor={onOpenRuleEditor}
                embedded
                {...(isConfirmationTarget
                  ? {
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
