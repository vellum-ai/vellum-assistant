import { Brain, X } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import { Typography } from "@vellumai/design-library";

import { ToolCallChip } from "@/domains/chat/components/tool-call-chip/tool-call-chip";
import {
  WebSearchProgressCard,
  type StepDescriptor,
} from "@/domains/chat/components/web-search/web-search-progress-card";
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
  WEB_TOOL_NAMES,
  toolDetailPayloadFromToolCall,
  type ToolCallCardData,
  type ToolCallCardItem,
  type ToolCallCardStep,
} from "@/domains/chat/hooks/tool-call-card-utils";
import { useToolCallCardDataFromItems } from "@/domains/chat/hooks/use-tool-call-card-data";
import type { ConfirmationDecision } from "@/types/event-types";
import type { AllowlistOption, DirectoryScopeOption, RiskScopeOption, ScopeOption } from "@/types/interaction-ui-types";
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

export interface ActivityRunCardProps {
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
  /**
   * Ephemeral parent-driven expansion for the currently active tool-call
   * group. Unlike `expandedCardIds`, this is not persisted; explicit user
   * toggles still win.
   */
  autoExpand?: boolean;
  onOpenRuleEditor?: (context: {
    toolName: string;
    riskLevel?: string;
    riskReason?: string;
    input?: Record<string, unknown>;
    allowlistOptions: AllowlistOption[];
    scopeOptions: ScopeOption[];
    riskScopeOptions: RiskScopeOption[];
    directoryScopeOptions: DirectoryScopeOption[];
    matchedTrustRuleId?: string;
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
 * Activity-run card. Renders a contiguous run of interleaved thinking + tool
 * steps as a single combined card. All tool groups — web search, bash, file
 * ops, MCP, computer use, skills — render through the shared
 * {@link ToolProgressCardShell} driven by {@link useToolCallCardData}.
 *
 * Special cases short-circuit before the shell:
 *
 * - `pendingConfirmationToolCallId` matches a tool call in this group →
 *   render the inline confirmation UI via {@link ToolCallChip} so the
 *   approve/deny path is preserved bit-for-bit from the legacy card.
 * - Zero renderable steps (today: a group made up entirely of
 *   `subagent_spawn` calls, which `useToolCallCardData` filters out) → render
 *   `null`; the spawned subagents render as inline
 *   `SubagentInlineProgressCard`s elsewhere in the transcript.
 */
export function ActivityRunCard(props: ActivityRunCardProps) {
  const {
    toolCalls,
    pendingConfirmationToolCallId,
    autoExpand = false,
  } = props;

  const hasActiveConfirmation =
    pendingConfirmationToolCallId != null &&
    toolCalls.some((tc) => tc.id === pendingConfirmationToolCallId);

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
  const expanded = useCardExpanded(
    cardId,
    props.expandedCardIds,
    autoExpand,
  );

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

  // Purely-web groups continue to flow through `WebSearchProgressCard` for
  // its mature rendering (carousel header, error chips). Mixed / non-web
  // groups fall through to the unified shell below.
  if (isPurelyWebGroup(toolCalls)) {
    return (
      <WebSearchView
        toolCalls={toolCalls}
        cardData={cardData}
        expanded={expanded.value}
        onExpandChange={expanded.onChange}
      />
    );
  }

  return (
    <UnifiedActivityRunCard
      {...props}
      cardData={cardData}
      expanded={expanded.value}
      onCardExpandChange={expanded.onChange}
    />
  );
}

/**
 * True when every tool call in the group is a web tool (`web_search` /
 * `web_fetch`). Mirrors the legacy purely-web predicate that gated the web
 * progress card before the unified card consolidated the two paths.
 */
function isPurelyWebGroup(toolCalls: ChatMessageToolCall[]): boolean {
  if (toolCalls.length === 0) return false;
  return toolCalls.every((tc) => WEB_TOOL_NAMES.has(tc.name));
}

/**
 * Renders the web-search variant by narrowing the unified card data to the
 * legacy `WebSearchProgressCard` props.
 *
 * State precedence (highest first):
 *   1. `"loading"` — any tool call still has `status === "running"`. A denied
 *      confirmation can race ahead of the error `tool_result`, so the legacy
 *      card has to stay in `"loading"` until the tool actually exits.
 *   2. unified `state === "error"` or `"denied"` — bubble the failed chrome
 *      up so a purely-web group that ends with a tool error reads as failed
 *      (consistent with mixed / non-web groups that already render through
 *      the unified shell's error icon).
 *   3. `"complete"` — every tool call reached a terminal status without
 *      failure.
 */
function WebSearchView({
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
  return (
    <WebSearchProgressCard
      currentStepTitle={cardData.currentStepTitle}
      currentStepInfo={cardData.currentStepInfo}
      stepCount={cardData.stepCount}
      // Every step in a purely-web group is one of the legacy three kinds
      // by construction — the `tool` variant only appears for non-web
      // tools, which this branch filters out.
      steps={cardData.steps as StepDescriptor[]}
      state={deriveWebShellState(toolCalls, cardData.state)}
      carouselItems={cardData.carouselItems}
      expanded={expanded}
      onExpandChange={onExpandChange}
    />
  );
}

function deriveWebShellState(
  toolCalls: ChatMessageToolCall[],
  unifiedState: ToolCallCardData["state"],
): ToolProgressCardState {
  if (toolCalls.some((tc) => isToolCallRunning(tc))) return "loading";
  if (unifiedState === "error" || unifiedState === "denied") return unifiedState;
  return "complete";
}

/**
 * Render the unified shell for a non-web tool-call group. Wraps
 * `ToolProgressCardShell` with a `PhaseGroupedStepList` body that groups
 * contiguous same-phase steps (`Working (bash)`, `Using a skill`, etc.)
 * under a single phase header. Mixed groups carry `web_search` /
 * `web_search_error` / `thinking` (the latter from web tools, e.g.
 * `web_fetch` "Reading …") alongside the `tool` variant emitted by
 * `useToolCallCardData` for non-web tools.
 */
function UnifiedActivityRunCard({
  toolCalls,
  cardData,
  expanded,
  onCardExpandChange,
  onOpenRuleEditor,
  unknownNudgeToolCallIds,
  onDismissUnknownNudge,
}: ActivityRunCardProps & {
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
  const shellState: ToolProgressCardState = cardData.state;

  // Nudge rows need the raw call (riskLevel, allowlistOptions, …) which
  // isn't carried on the step descriptor. The pill's click handler also
  // reads the raw call to build the tool-detail drawer payload.
  const toolCallById = new Map(toolCalls.map((tc) => [tc.id, tc]));

  // When the latest step is a thinking segment, the collapsed header pairs a
  // brain glyph with the thinking text. Memoized so the carousel (which
  // compares the info node by reference via `Object.is`) doesn't re-animate on
  // every parent render — only when the (kind, info) tuple actually changes.
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

  return (
    <ToolProgressCardShell
      // The unified (non-web) activity card renders bare — its header status
      // icon + phase headers flow inline on the chat background like the
      // `ThoughtProcessLink` / `InlineToolLink`, with a ghost hover on the
      // header row instead of the boxed card chrome. The purely-web path
      // (`WebSearchView`) and the subagent inline card stay boxed.
      bare
      state={shellState}
      currentStepTitle={cardData.currentStepTitle}
      currentStepInfo={headerInfo}
      stepCount={cardData.stepCount}
      expanded={expanded}
      onExpandChange={onCardExpandChange}
    >
      {/* Bare body in TIMELINE mode. Left padding is ZERO so the timeline node
          icons' left edge lines up EXACTLY with the bare header's status icon
          (which sits at the card content-left, x≈0, via the header Button's
          `-ml-1.5 px-1.5` net-zero offset). `pt-2` (8px) plus the connector
          lead-in bridges the gap up to the header icon; `pr-3 pb-2` keep the
          right/bottom breathing room. The body wrapper owns no `gap` — each
          timeline section owns its own spacing via `pb-3`. */}
      <div className="flex w-full flex-col pb-2 pl-px pr-3 pt-4">
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
 * (now or in a previous mount, recorded in `expandedCardIds`) wins across
 * state transitions and remounts.
 *
 * `localToggle` mirrors the map mutation so React re-renders on click —
 * mutating the map alone wouldn't trigger one.
 */
function useCardExpanded(
  cardId: string | null,
  expandedCardIds: Map<string, boolean>,
  autoExpand: boolean,
): { value: boolean; onChange: (next: boolean) => void } {
  const [localToggle, setLocalToggle] = useState<boolean | undefined>(
    undefined,
  );
  const persisted =
    cardId != null ? expandedCardIds.get(cardId) : undefined;
  const userChoice = localToggle ?? persisted;
  const value = userChoice ?? autoExpand;

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
  onOpenRuleEditor: NonNullable<ActivityRunCardProps["onOpenRuleEditor"]>;
  onDismiss?: ActivityRunCardProps["onDismissUnknownNudge"];
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
            riskScopeOptions: toolCall.riskScopeOptions ?? [],
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
 * matches the dedicated `WebSearchProgressCard`; all other variants fall
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
  expandedToolCallIds,
  onExpandChange,
  onOpenRuleEditor,
  isSubmittingConfirmation,
  onConfirmationSubmit,
  onAllowAndCreateRule,
  pendingConfirmationToolCallId,
  unknownNudgeToolCallIds,
  onDismissUnknownNudge,
}: ActivityRunCardProps) {
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
