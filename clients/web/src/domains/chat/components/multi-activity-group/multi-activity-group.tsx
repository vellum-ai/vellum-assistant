import { Brain, X } from "lucide-react";
import { Fragment, useCallback, useMemo } from "react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";

import { Typography } from "@vellumai/design-library";

import { ToolCallChip } from "@/domains/chat/components/tool-call-chip/tool-call-chip";
import { SingleActivity } from "@/domains/chat/components/single-activity/single-activity";
import {
  WebSearchErrorRow,
  WebSearchStepRow,
} from "@/domains/chat/components/web-search/web-search-step-row";
import {
  DefaultStepPill,
  PhaseGroupedStepList,
} from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
import { ToolStepPill } from "@/domains/chat/components/tool-progress-card/tool-step-pill";
import {
  ToolProgressCardShell,
  type ToolProgressCardState,
} from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell";
import { useViewerStore } from "@/stores/viewer-store";
import {
  toolDetailPayloadFromToolCall,
  type ToolCallCardData,
  type ToolCallCardItem,
  type ToolCallCardStep,
} from "@/domains/chat/utils/tool-call-card-utils";
import { useToolCallCardDataFromItems } from "@/domains/chat/hooks/use-tool-call-card-data";
import type { ConfirmationDecision } from "@/types/event-types";
import type { AllowlistOption, DirectoryScopeOption, ScopeOption } from "@/types/interaction-ui-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { toolCallToRuleContext } from "@/domains/chat/utils/chat";
import { truncate } from "@/domains/chat/utils/truncate";
import { isToolCallRunning } from "@/domains/chat/utils/tool-call-status";

/**
 * Hard character cap on the thinking-step pill label. The pill already
 * truncates by container width, but reasoning text can be long enough to
 * dominate the body before that fires — this caps it well short so the pill
 * stays compact and the full text lives behind the side-drawer.
 */
const THINKING_PILL_MAX_CHARS = 60;

/**
 * Hard character cap for the thinking text shown in the collapsed header's
 * carousel info slot. Like the pill (`THINKING_PILL_MAX_CHARS`), the header
 * concatenates the reasoning text with an ellipsis so a long thinking segment
 * doesn't fill the row and collide with the step-count pill. CSS `truncate`
 * is the responsive safety net; this cap makes it concatenate sooner.
 */
const HEADER_INFO_MAX_CHARS = 80;

export interface MultiActivityGroupProps {
  toolCalls: ChatMessageToolCall[];
  /**
   * Ephemeral parent-driven expansion for the currently active tool-call
   * group. Unlike store-persisted `expandedCardIds`, this is not persisted;
   * explicit user toggles still win.
   */
  autoExpand?: boolean;
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
   * Ordered (thinking | toolCall) items driving the expanded body. When
   * supplied, the card interleaves thinking steps between tool steps in the
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
 * not "half failed".
 */
function countStepOutcomes(steps: ToolCallCardStep[]): {
  total: number;
  failed: number;
} {
  let total = 0;
  let failed = 0;
  for (const step of steps) {
    if (step.kind === "thinking") continue;
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
 * count toward the tally (see {@link countStepOutcomes}).
 */
function deriveSummaryState(
  baseState: ToolCallCardData["state"],
  steps: ToolCallCardStep[],
): ToolProgressCardState {
  if (baseState === "loading" || baseState === "complete") return baseState;
  // baseState is `error` / `denied` → at least one failure is present.
  const { total, failed } = countStepOutcomes(steps);
  if (failed > 0 && failed < total) return "warning";
  return "error";
}

/**
 * Stable header label shown in place of the live per-step title once the card
 * is expanded. The status icon to its left already encodes the outcome, so
 * this stays a short heading for the steps timeline rather than echoing the
 * latest step.
 *
 * Whenever we have timing data the summary reports how long the agent worked —
 * a live, ticking "Working for 16s" while running and a final "Worked for 16s"
 * once terminal, regardless of outcome (the icon still carries success /
 * partial / failure). Without timing data it falls back to an outcome label,
 * and the `warning` fallback spells out how many tools failed.
 */
function expandedHeaderLabel(
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
  if (totalDurationLabel) return `Worked for ${totalDurationLabel}`;
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
 * steps as a single combined card — the multi-step counterpart to the lone
 * `SingleActivity` link. All tool groups — web search, bash, file
 * ops, MCP, computer use, skills — render through the shared
 * {@link ToolProgressCardShell} driven by {@link useToolCallCardData}.
 *
 * Special cases short-circuit before the shell:
 *
 * - a LONE `web_search` call → render the inline, expand-in-place
 *   `SingleActivity variant="web"` link. Lone `web_fetch`, grouped (2+)
 *   web, and mixed groups fall through to the unified shell.
 * - any tool call in this group carries a `pendingConfirmation` → render the
 *   inline confirmation UI via {@link ToolCallChip} so the approve/deny path
 *   is preserved bit-for-bit from the legacy card.
 * - Zero renderable steps (today: a group made up entirely of
 *   `subagent_spawn` calls, which `useToolCallCardData` filters out) → render
 *   `null`; the spawned subagents render as inline
 *   `SubagentInlineProgressCard`s elsewhere in the transcript.
 */
export function MultiActivityGroup(props: MultiActivityGroupProps) {
  const {
    toolCalls,
    autoExpand = false,
  } = props;

  const hasActiveConfirmation = toolCalls.some(
    (tc) => !!tc.pendingConfirmation,
  );

  // downstream branch share the same projection. When the caller supplies
  // ordered `items` (the activity-summary merged-card path) those drive the
  // body directly; otherwise we synthesize one item per tool call. Computed
  // once via a single hook call so there are no conditional hooks.
  //
  // `subagent_spawn` calls are filtered out inside the projection — they're
  // rendered inline by `SubagentInlineProgressCard` at the transcript level.
  // If a group reduces to zero renderable steps the dispatcher falls through
  // to a no-op below.
  const effectiveItems = useMemo(
    () => props.items ?? buildDefaultItems(toolCalls),
    [props.items, toolCalls],
  );
  const cardData = useToolCallCardDataFromItems(effectiveItems);
  const cardId = toolCalls[0]?.id ?? null;
  const expanded = useCardExpanded(cardId, autoExpand);

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
  // mixed groups fall through to the unified shell below.
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
      expanded={expanded.value}
      onCardExpandChange={expanded.onChange}
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
 * Render the unified shell for a non-web tool-call group. Wraps
 * `ToolProgressCardShell` with a `PhaseGroupedStepList` body that groups
 * contiguous same-phase steps (`Working`, `Using a skill`, etc.)
 * under a single phase header. Mixed groups carry `web_search` /
 * `web_search_error` / `thinking` (the latter from web tools, e.g.
 * `web_fetch` "Reading …") alongside the `tool` variant emitted by
 * `useToolCallCardData` for non-web tools.
 */
function UnifiedMultiActivityGroup({
  toolCalls,
  cardData,
  expanded,
  onCardExpandChange,
  onOpenRuleEditor,
  unknownNudgeToolCallIds,
  onDismissUnknownNudge,
}: MultiActivityGroupProps & {
  cardData: ToolCallCardData;
  expanded: boolean;
  onCardExpandChange: (next: boolean) => void;
}) {
  // Pills TOGGLE the shared tool-detail drawer: clicking an open pill closes
  // its drawer, clicking another switches to it.
  const toggleToolDetail = useViewerStore.use.toggleToolDetail();
  // The active drawer payload drives the pill's selected state. For tool pills
  // we match on `toolCallId`; for thinking pills (which carry an empty
  // `toolCallId`) we match on the thinking text instead.
  const activeDetail = useViewerStore.use.activeToolDetail();
  // Drives the tool pill's active state — the pill whose detail drawer is
  // currently open renders selected. `null` when the drawer is closed or
  // showing another view, so no pill reads as active.
  const openToolDetailId = activeDetail?.toolCallId ?? null;
  // A partial failure (some tools failed, some succeeded) reads as an amber
  // `warning` rather than a full red `error`; an all-failed run stays `error`.
  const outcomes = countStepOutcomes(cardData.steps);
  const shellState: ToolProgressCardState = deriveSummaryState(
    cardData.state,
    cardData.steps,
  );

  // Nudge rows need the raw call (riskLevel, allowlistOptions, …) which
  // isn't carried on the step descriptor. The pill's click handler also
  // reads the raw call to build the tool-detail drawer payload.
  const toolCallById = new Map(toolCalls.map((tc) => [tc.id, tc]));

  // The header shows the stable overall-status summary ("Working for 8s" /
  // "Worked for 8s" / "Failed") rather than the live per-step carousel ONLY
  // when expanded: the full timeline is visible below, so echoing the latest
  // step in the header would be pure repetition.
  //
  // A collapsed card — whether still running or terminal — carousels the
  // latest step (`currentStepTitle | currentStepInfo`) so a compact card
  // summarises what's running / what ran. A collapsed running card keeps its
  // three-dot indicator (see `hideStatusIndicator` below) and now pairs it
  // with the live title + info.
  const isLoading = shellState === "loading";
  const showSummaryHeader = expanded;
  const headerTitle = showSummaryHeader
    ? expandedHeaderLabel(
        shellState,
        cardData.totalDurationLabel ?? "",
        outcomes.failed,
      )
    : cardData.currentStepTitle;

  // When the latest step is a thinking segment, the collapsed header pairs a
  // brain glyph with the thinking text. Suppressed for the summary header (the
  // ticking duration / expanded timeline stand in). Memoized so the carousel
  // (which compares the info node by reference via `Object.is`) doesn't
  // re-animate on every parent render — only when the (summary, kind, info)
  // tuple actually changes.
  const headerInfo = useMemo(() => {
    if (showSummaryHeader) return null;
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
  }, [showSummaryHeader, cardData.currentStepKind, cardData.currentStepInfo]);

  return (
    <ToolProgressCardShell
      // The unified activity card (grouped/mixed, including grouped web)
      // renders bare — its header status icon + phase headers flow inline on
      // the chat background like the lone `SingleActivity` link, with a ghost
      // hover on the header row instead of the boxed card chrome. The lone-web
      // path renders the inline `SingleActivity` link; the subagent inline
      // card stays boxed.
      bare
      state={shellState}
      currentStepTitle={headerTitle}
      currentStepInfo={headerInfo}
      // The summary header ("Working for Ns" / "Worked for Ns") is a single
      // stable label whose only changing part is the duration, so a constant
      // animation key keeps the carousel from re-sliding — the text updates in
      // place. (Collapsed + terminal still carousels the latest step, hence the
      // key only pins while the summary header is shown.)
      headerAnimationKey={showSummaryHeader ? "summary" : undefined}
      // Expanded + running: drop the header's animated loading dots — the
      // timeline below already shows the live step's running indicator, so the
      // dots are redundant noise. Terminal icons (the finished checkmark /
      // failure alert) still render when expanded so the header keeps its
      // outcome-at-a-glance summary; collapsed always keeps its indicator.
      hideStatusIndicator={expanded && isLoading}
      stepCount={cardData.stepCount}
      expanded={expanded}
      onExpandChange={onCardExpandChange}
    >
      {/* Bare body in TIMELINE mode. `pl-[18px]` indents the whole expanded
          timeline in from the bare header's status icon so the steps read as
          children nested under the header rather than flush with it. `pt-4`
          plus the connector lead-in bridges the gap up to the header; `pr-3
          pb-2` keep the right/bottom breathing room. The body wrapper owns no
          `gap` — each timeline section owns its own spacing via `pb-3`. */}
      <div className="flex w-full flex-col pb-2 pl-[18px] pr-3 pt-4">
        <PhaseGroupedStepList
          steps={cardData.steps}
          timeline
          renderStep={(step) => {
            // Thinking steps render as a clickable, brain-branded pill that
            // opens the full reasoning in the shared tool-detail drawer.
            if (step.kind === "thinking") {
              const active =
                activeDetail?.kind === "thinking" &&
                activeDetail.thinkingText === step.text;
              return (
                <ToolStepPill
                  iconName="brain"
                  label={truncate(step.text, THINKING_PILL_MAX_CHARS)}
                  ariaLabel="View thinking"
                  active={active}
                  tone="default"
                  onClick={() => {
                    // Pin the card open: opening the drawer flips `mainView`,
                    // which remounts the transcript and resets local expand
                    // state. Persisting the user's intent keeps the accordion
                    // open across that remount (mirrors the tool pill).
                    onCardExpandChange(true);
                    toggleToolDetail({
                      kind: "thinking",
                      toolCallId: "",
                      toolName: "",
                      title: "Thinking",
                      activity: "",
                      input: {},
                      status: "completed",
                      thinkingText: step.text,
                    });
                  }}
                />
              );
            }
            // Other non-`tool` kinds (web_search, web_search_error,
            // tool_error) keep their dedicated rows via `ExpandedStep`.
            if (step.kind !== "tool") {
              return <ExpandedStep step={step} />;
            }

            const nudgeTarget = unknownNudgeToolCallIds?.has(step.toolCallId)
              ? toolCallById.get(step.toolCallId)
              : undefined;
            return (
              <>
                <ToolStepPill
                  iconName={step.iconName}
                  label={step.activity || step.info || step.title}
                  riskLevel={step.riskLevel}
                  active={openToolDetailId === step.toolCallId}
                  tone={
                    step.status === "error" || step.status === "denied"
                      ? "error"
                      : "default"
                  }
                  onClick={() => {
                    const tc = toolCallById.get(step.toolCallId);
                    if (!tc) return;
                    // Pin the card open: opening the drawer flips `mainView`,
                    // which remounts the transcript and resets local expand
                    // state. Persisting the user's intent in `expandedCardIds`
                    // keeps the parent accordion open across that remount.
                    onCardExpandChange(true);
                    toggleToolDetail(toolDetailPayloadFromToolCall(tc));
                  }}
                  onRiskBadgeClick={
                    onOpenRuleEditor
                      ? () => {
                          const tc = toolCallById.get(step.toolCallId);
                          if (!tc) return;
                          onOpenRuleEditor(toolCallToRuleContext(tc));
                        }
                      : undefined
                  }
                />
                {nudgeTarget && onOpenRuleEditor && (
                  <UnknownCommandNudge
                    toolCall={nudgeTarget}
                    onOpenRuleEditor={onOpenRuleEditor}
                    onDismiss={onDismissUnknownNudge}
                  />
                )}
              </>
            );
          }}
        />
      </div>
    </ToolProgressCardShell>
  );
}

/**
 * Drives the unified card's expand/collapse state. Tool progress cards default
 * collapsed in chat so past tool activity stays compact. The transcript can
 * temporarily expand the current active group via `autoExpand`; a user toggle
 * (recorded in `expandedCardIds` in the session store) wins across state
 * transitions and remounts.
 *
 * Subscribes reactively via a Zustand selector — the store action produces a
 * new Map instance on toggle, so this component re-renders without needing a
 * local useState mirror.
 */
function useCardExpanded(
  cardId: string | null,
  autoExpand: boolean,
): { value: boolean; onChange: (next: boolean) => void } {
  const persisted = useChatSessionStore(
    (s) => (cardId != null ? s.expandedCardIds.get(cardId) : undefined),
  );
  const value = persisted ?? autoExpand;

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

/**
 * Render a single step inside the expanded body of a phase section. The
 * `web_search` and `web_search_error` variants delegate to the shared
 * `WebSearchStepRow` / `WebSearchErrorRow` primitives so the visual language
 * matches the lone-web inline link; all other variants fall
 * through to {@link DefaultStepPill} which matches Figma `5010-103135`.
 */
function ExpandedStep({ step }: { step: ToolCallCardStep }) {
  if (step.kind === "web_search") {
    return <WebSearchStepRow step={step} />;
  }
  if (step.kind === "web_search_error") {
    return <WebSearchErrorRow step={step} />;
  }
  return <DefaultStepPill step={step} />;
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
