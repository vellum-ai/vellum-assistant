import { X } from "lucide-react";
import { Fragment, useState } from "react";

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
  type ToolCallCardData,
  type ToolCallCardStep,
} from "@/domains/chat/hooks/tool-call-card-utils";
import { useToolCallCardData } from "@/domains/chat/hooks/use-tool-call-card-data";
import type { ConfirmationDecision } from "@/types/event-types";
import type { AllowlistOption, DirectoryScopeOption, RiskScopeOption, ScopeOption } from "@/types/interaction-ui-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { toolCallToRuleContext } from "@/domains/chat/utils/chat";
import { deriveToolCallStatus } from "@/domains/chat/utils/derive-tool-call-status";

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
 * - Zero renderable steps (today: a group made up entirely of
 *   `subagent_spawn` calls, which `useToolCallCardData` filters out) → render
 *   `null`; the spawned subagents render as inline
 *   `SubagentInlineProgressCard`s elsewhere in the transcript.
 */
export function ToolCallProgressCard(props: ToolCallProgressCardProps) {
  const {
    toolCalls,
    pendingConfirmationToolCallId,
    autoExpand = false,
  } = props;

  const hasActiveConfirmation =
    pendingConfirmationToolCallId != null &&
    toolCalls.some((tc) => tc.id === pendingConfirmationToolCallId);

  // Single subscription to the unified hook so the dispatcher and every
  // downstream branch share the same projection.
  //
  // `subagent_spawn` calls are filtered out inside `computeToolCallCardData`
  // — they're rendered inline by `SubagentInlineProgressCard` at the
  // transcript level. If a group reduces to zero renderable steps the
  // dispatcher falls through to a no-op below.
  const cardData = useToolCallCardData(toolCalls);
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
    <UnifiedToolCallProgressCard
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
  if (toolCalls.some((tc) => deriveToolCallStatus(tc) === "running")) return "loading";
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
function UnifiedToolCallProgressCard({
  toolCalls,
  cardData,
  expanded,
  onCardExpandChange,
  onOpenRuleEditor,
  unknownNudgeToolCallIds,
  onDismissUnknownNudge,
}: ToolCallProgressCardProps & {
  cardData: ToolCallCardData;
  expanded: boolean;
  onCardExpandChange: (next: boolean) => void;
}) {
  const openToolDetail = useViewerStore.use.openToolDetail();
  // Drives the pill's active state — the pill whose detail drawer is currently
  // open renders selected. `null` when the drawer is closed or showing another
  // view, so no pill reads as active.
  const openToolDetailId = useViewerStore.use.activeToolDetail()?.toolCallId ?? null;
  const shellState: ToolProgressCardState = cardData.state;

  // Nudge rows need the raw call (riskLevel, allowlistOptions, …) which
  // isn't carried on the step descriptor. The pill's click handler also
  // reads the raw call to build the tool-detail drawer payload.
  const toolCallById = new Map(toolCalls.map((tc) => [tc.id, tc]));

  return (
    <ToolProgressCardShell
      state={shellState}
      currentStepTitle={cardData.currentStepTitle}
      currentStepInfo={cardData.currentStepInfo}
      stepCount={cardData.stepCount}
      expanded={expanded}
      onExpandChange={onCardExpandChange}
    >
      <div className="flex w-full flex-col gap-3 px-3 pb-3">
        <PhaseGroupedStepList
          steps={cardData.steps}
          renderStep={(step) => {
            // Non-`tool` kinds (thinking, web_search, web_search_error,
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
                    openToolDetail({
                      toolCallId: tc.id,
                      toolName: tc.name,
                      title: step.title,
                      activity: step.activity,
                      input: tc.input ?? {},
                      result: tc.result,
                      status: step.status,
                      riskLevel: tc.riskLevel,
                      riskReason: tc.riskReason,
                      durationLabel: step.durationLabel,
                    });
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
