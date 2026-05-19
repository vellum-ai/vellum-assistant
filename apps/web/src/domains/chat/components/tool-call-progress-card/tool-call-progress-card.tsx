
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  X,
} from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { BusyIndicator } from "@/domains/chat/components/busy-indicator.js";
import { ToolCallChip } from "@/domains/chat/components/tool-call-chip/tool-call-chip.js";
import {
  extractInputSummary,
  friendlyRunningLabel,
  progressiveLabels,
  toolCategory,
} from "@/domains/chat/components/tool-call-chip/utils.js";
import type {
  AllowlistOption,
  ChatMessageToolCall,
  ConfirmationDecision,
  DirectoryScopeOption,
  ScopeOption,
} from "@/domains/chat/lib/api.js";
import { useElapsedTime } from "@/domains/chat/lib/use-elapsed-time.js";

// ---------------------------------------------------------------------------
// Phase system — mirrors macOS ProgressCardPhase
// ---------------------------------------------------------------------------

/**
 * Resolved display phase for the progress card header.
 *
 * - `thinking`   — all tools complete, assistant is streaming its response
 *                  (post-tool thinking gap). Mirrors macOS `.toolsCompleteThinking`.
 * - `toolRunning` — at least one tool call is in flight.
 * - `complete`   — all tools done, turn finished, no denials.
 * - `denied`     — one or more tool calls were blocked/denied.
 */
type Phase = "thinking" | "toolRunning" | "complete" | "denied";

function computePhase({
  hasRunning,
  allCompleted,
  hasDenied,
  isStreaming,
}: {
  hasRunning: boolean;
  allCompleted: boolean;
  hasDenied: boolean;
  isStreaming: boolean;
}): Phase {
  // Mirrors macOS resolvePhase priority order exactly:
  // 1. Denied takes precedence over toolRunning — if any tool was blocked and tools are
  //    still incomplete, show denied even if another tool is still actively running.
  //    (macOS line 288: `if hasDeniedToolCalls && hasIncompleteTools { return .denied }`)
  if (hasDenied && !allCompleted) return "denied";
  if (hasRunning) return "toolRunning";
  if (allCompleted && isStreaming && !hasDenied) return "thinking";
  return "complete";
}

// ---------------------------------------------------------------------------
// Progressive label hook — cycles through descriptive labels for app tools
// ---------------------------------------------------------------------------

/** Interval in ms between label advances — matches macOS ~8s timing. */
const PROGRESSIVE_LABEL_INTERVAL_MS = 8_000;

/**
 * Returns the current progressive label for a running app tool, or null for
 * tools that don't have progressive labels. Advances through the label array
 * on a timer and resets when the tool call changes.
 *
 * The index is stored in state and advanced by the interval callback. When
 * `startedAt` changes (new tool invocation), the effect tears down and
 * re-runs, resetting the index to 0 via the initializer.
 */
function useProgressiveLabel(
  toolName: string | undefined,
  startedAt: number | undefined,
): string | null {
  const labels = useMemo(
    () => (toolName ? progressiveLabels(toolName) : []),
    [toolName],
  );

  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (labels.length === 0) return;

    // Reset to 0 whenever this effect re-runs (tool or startedAt changed).
    setIndex(0);

    const id = setInterval(() => {
      setIndex((prev) => Math.min(prev + 1, labels.length - 1));
    }, PROGRESSIVE_LABEL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [labels, startedAt]);

  if (labels.length === 0) return null;
  return labels[index] ?? null;
}

// ---------------------------------------------------------------------------
// Headline
// ---------------------------------------------------------------------------

function computeHeadline(
  phase: Phase,
  totalSteps: number,
  deniedCount: number,
  currentRunningCall: ChatMessageToolCall | undefined,
  firstDeniedCall: ChatMessageToolCall | undefined,
  skillExecuteLabel: string,
): string {
  switch (phase) {
    case "thinking":
      return "Thinking...";

    case "toolRunning": {
      if (currentRunningCall) {
        const reason = currentRunningCall.input?.reason;
        if (typeof reason === "string" && reason.trim()) {
          return reason.trim();
        }
        if (currentRunningCall.toolName === "skill_execute") {
          return skillExecuteLabel;
        }
        const inputSummary = extractInputSummary(
          currentRunningCall.toolName,
          currentRunningCall.input,
        );
        const buildingStatus =
          typeof currentRunningCall.input.building_status === "string"
            ? currentRunningCall.input.building_status
            : undefined;
        return friendlyRunningLabel(currentRunningCall.toolName, inputSummary, buildingStatus);
      }
      const suffix = totalSteps !== 1 ? "s" : "";
      return `Running ${totalSteps} step${suffix}`;
    }

    case "denied": {
      // Mirrors macOS headlineText for .denied:
      // `ChatBubble.friendlyRunningLabel(primary) + " denied"`
      // where primary = uniqueToolNamesSorted.first. Shows e.g. "Fetching a webpage denied"
      // rather than "Completed with N blocked permissions" — that string belongs at .complete.
      if (firstDeniedCall) {
        const inputSummary = extractInputSummary(firstDeniedCall.toolName, firstDeniedCall.input);
        return `${friendlyRunningLabel(firstDeniedCall.toolName, inputSummary)} denied`;
      }
      const permSuffix = deniedCount !== 1 ? "s" : "";
      return `Completed with ${deniedCount} blocked permission${permSuffix}`;
    }

    case "complete":
    default: {
      // Mirrors macOS headlineText for .complete with hasDeniedToolCalls:
      // `"Completed with \(model.deniedCount) blocked permission\(s)"`
      if (deniedCount > 0) {
        const permSuffix = deniedCount !== 1 ? "s" : "";
        return `Completed with ${deniedCount} blocked permission${permSuffix}`;
      }
      const suffix = totalSteps !== 1 ? "s" : "";
      return `Completed ${totalSteps} step${suffix}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

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
   * Used to detect the post-tool thinking phase so we can show "Thinking..."
   * instead of "Completed N steps" while the turn is still active.
   */
  isStreaming?: boolean;
}

function CardStatusIcon({
  phase,
  hasDenied,
  isTimeout,
}: {
  phase: Phase;
  hasDenied: boolean;
  isTimeout: boolean;
}) {
  switch (phase) {
    case "thinking":
    case "toolRunning":
      return <BusyIndicator size={8} />;
    case "denied":
      // Timed-out denials: clock icon in muted tertiary. Active denials: circleAlert in red.
      // Mirrors macOS statusIcon() which checks decidedConfirmations for .timedOut.
      return isTimeout
        ? <Clock className="h-4 w-4 text-[var(--content-tertiary)] shrink-0" />
        : <AlertCircle className="h-4 w-4 text-[var(--system-negative-strong)] shrink-0" />;
    case "complete":
    default:
      // When some tools were blocked but the overall turn completed, show a warning
      // triangle (systemNegativeHover) instead of a success check. Mirrors macOS
      // statusIcon() which uses .triangleAlert when model.hasDeniedToolCalls.
      return hasDenied
        ? <AlertTriangle className="h-4 w-4 text-[var(--system-negative-hover)] shrink-0" />
        : <CheckCircle2 className="h-4 w-4 text-[var(--system-positive-strong)] shrink-0" />;
  }
}

/**
 * Dynamically shows as many permission chips as fit in the available space,
 * with a "+N" overflow indicator for the rest. Uses ResizeObserver to
 * recalculate on container resize.
 *
 * The component returns a Fragment with a divider + a flex-1 container so the
 * chip area fills the remaining header space between headline and time/chevron.
 */
function CollapsedPermissionChips({
  toolCalls,
}: {
  toolCalls: ChatMessageToolCall[];
}) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const chipWidthsRef = useRef<Map<string, number>>(new Map());
  const [maxVisible, setMaxVisible] = useState<number | null>(null);

  const decidedCalls = useMemo(
    () => toolCalls.filter((tc) => tc.riskLevel != null),
    [toolCalls],
  );

  // Measure chip widths and calculate how many fit. useLayoutEffect prevents
  // a visible flash on first render (all chips are rendered initially to
  // measure them, then trimmed before the browser paints).
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || decidedCalls.length === 0) return;

    const GAP = 6; // gap-1.5
    const OVERFLOW_BADGE_WIDTH = 32; // approximate "+N" width

    const recalculate = () => {
      const containerWidth = container.offsetWidth;
      if (containerWidth <= 0) {
        setMaxVisible(0);
        return;
      }

      // Cache widths of any chip elements currently in the DOM
      const chipEls = container.querySelectorAll<HTMLElement>("[data-chip-id]");
      chipEls.forEach((el) => {
        chipWidthsRef.current.set(el.dataset.chipId!, el.offsetWidth);
      });

      let usedWidth = 0;
      let count = 0;

      for (let i = 0; i < decidedCalls.length; i++) {
        const tc = decidedCalls[i];
        if (!tc) break;
        const chipWidth = chipWidthsRef.current.get(tc.id) ?? 140;
        const needed = (count > 0 ? GAP : 0) + chipWidth;

        if (i === decidedCalls.length - 1) {
          // Last chip — only needs to fit (no overflow badge)
          if (usedWidth + needed <= containerWidth) count++;
        } else {
          // Not last — needs room for chip + gap + overflow badge
          if (
            usedWidth + needed + GAP + OVERFLOW_BADGE_WIDTH <=
            containerWidth
          ) {
            usedWidth += needed;
            count++;
          } else {
            break;
          }
        }
      }

      setMaxVisible(count);
    };

    recalculate();
    const observer = new ResizeObserver(recalculate);
    observer.observe(container);
    return () => observer.disconnect();
  }, [decidedCalls]);

  if (decidedCalls.length === 0) return null;

  // On initial render (maxVisible === null), show all chips so we can measure
  // them. overflow-hidden on the container prevents the user from seeing any
  // overflow before the layout effect trims the list.
  const effectiveMax = maxVisible ?? decidedCalls.length;
  const visible = decidedCalls.slice(0, effectiveMax);
  const overflowCount = decidedCalls.length - effectiveMax;

  return (
    <>
      <span className="h-4 w-px shrink-0 bg-[var(--border-base)]" />
      <span
        ref={containerRef}
        className="flex-1 min-w-0 flex items-center gap-1.5 overflow-hidden"
      >
        {visible.map((tc) => {
          const isTimeout = tc.confirmationDecision === "timed_out";
          const isDenied = tc.confirmationDecision === "denied";
          // 3-state color matching macOS CompactPermissionChip:
          // approved → primaryBase, denied → systemNegativeStrong, timedOut → contentTertiary
          const color = isDenied
            ? "var(--system-negative-strong)"
            : isTimeout
              ? "var(--content-tertiary)"
              : "var(--primary-base)";
          // timedOut chips show "Timed Out" label override, matching macOS CompactPermissionChip.
          // Non-timeout chips use toolCategory for short category labels ("Run Command",
          // "Write File", "Browser") instead of past-tense contextual text.
          const label = isTimeout
            ? "Timed Out"
            : toolCategory(tc.toolName);

          return (
            <span
              key={tc.id}
              data-chip-id={tc.id}
              className="flex items-center gap-0.5 text-label-small-default rounded-full px-1.5 py-0.5 shrink-0"
              style={{
                color,
                // Colored capsule border at 30% opacity — mirrors macOS
                // Capsule().stroke(chipColor.opacity(0.3), lineWidth: 1)
                boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 30%, transparent)`,
              }}
            >
              {isDenied ? (
                <AlertCircle className="h-2.5 w-2.5 shrink-0" />
              ) : isTimeout ? (
                <Clock className="h-2.5 w-2.5 shrink-0" />
              ) : (
                <CheckCircle2 className="h-2.5 w-2.5 shrink-0" />
              )}
              <span className="truncate max-w-[8rem]">{label}</span>
            </span>
          );
        })}
        {overflowCount > 0 && (
          <span
            data-overflow
            className="text-label-small-default text-[var(--content-tertiary)] shrink-0"
          >
            +{overflowCount}
          </span>
        )}
      </span>
    </>
  );
}

// ---------------------------------------------------------------------------
// ThinkingRow — post-tool synthetic thinking phase row
// ---------------------------------------------------------------------------

/**
 * Shown at the bottom of the expanded chip list when all tools are done but
 * the assistant is still composing its reply. Ticks every second to give a
 * sense of live activity. Mirrors macOS ThinkingStepRow.
 */
function ThinkingRow({ sinceMs }: { sinceMs: number | undefined }) {
  const [elapsed, setElapsed] = useState(() =>
    sinceMs !== undefined ? Math.floor((Date.now() - sinceMs) / 1000) : 0,
  );

  useEffect(() => {
    if (sinceMs === undefined) return;
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - sinceMs) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [sinceMs]);

  if (sinceMs === undefined) return null;

  return (
    <div className="flex items-center gap-2 pl-6 pr-3 py-2 text-body-small-default">
      <BusyIndicator size={6} />
      <span className="text-[var(--content-secondary)]">Thinking</span>
      <span className="ml-auto text-[var(--content-tertiary)]">{elapsed}s</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ToolCallProgressCard({
  toolCalls,
  expandedToolCallIds,
  onExpandChange,
  expandedCardIds,
  onOpenRuleEditor,
  isSubmittingConfirmation,
  onConfirmationSubmit,
  onAllowAndCreateRule,
  pendingConfirmationToolCallId,
  unknownNudgeToolCallIds,
  onDismissUnknownNudge,
  isStreaming = false,
}: ToolCallProgressCardProps) {
  const cardId = toolCalls[0]?.id;
  const hasActiveConfirmation = pendingConfirmationToolCallId
    ? toolCalls.some((tc) => tc.id === pendingConfirmationToolCallId)
    : false;

  const {
    hasRunning,
    hasDenied,
    hasTimeout,
    deniedCount,
    earliestStart,
    latestCompleted,
    allCompleted,
    currentRunningCall,
    firstDeniedCall,
    skillExecuteLabel,
  } = useMemo(() => {
    let running = false;
    let denied = 0;
    let timeout = false;
    let minStart: number | undefined;
    let maxComplete: number | undefined;
    // Status-first: a non-running tool is done regardless of completedAt.
    // completedAt is only used for displayed duration, not completion gating.
    let allDone = toolCalls.length > 0;
    let firstRunning: ChatMessageToolCall | undefined;
    let firstDenied: ChatMessageToolCall | undefined;
    let lastSkillLoad: ChatMessageToolCall | undefined;

    for (const tc of toolCalls) {
      if (tc.status === "running") {
        // Decouple "actively running" from "incomplete". Only denied/timed-out tools
        // are excluded from hasRunning — they're waiting for the daemon to send back
        // the error tool_result, not doing active work. Approved tools (confirmationDecision
        // === "approved") are stamped immediately on user click but are still executing,
        // so they must stay in the running pool. Undecided tools (null) are also running.
        // This mirrors macOS ToolCallData.isComplete (false until tool_result) vs isRunning.
        const isDeniedDecision =
          tc.confirmationDecision === "denied" || tc.confirmationDecision === "timed_out";
        if (!isDeniedDecision) {
          running = true;
          if (!firstRunning) firstRunning = tc;
        }
        // allCompleted still tracks any status="running" tool, decided or not,
        // so the "denied" branch (hasDenied && !allCompleted) fires correctly.
        allDone = false;
      }
      if (tc.confirmationDecision === "denied" || tc.confirmationDecision === "timed_out") {
        denied++;
        if (!firstDenied) firstDenied = tc;
      }
      if (tc.confirmationDecision === "timed_out") {
        timeout = true;
      }
      if (tc.toolName === "skill_load" && tc.status !== "running") {
        lastSkillLoad = tc;
      }
      if (tc.startedAt != null && (minStart === undefined || tc.startedAt < minStart)) minStart = tc.startedAt;
      if (tc.completedAt != null && (maxComplete === undefined || tc.completedAt > maxComplete)) maxComplete = tc.completedAt;
    }

    // Derive contextual label for skill_execute from the last completed skill_load's input.
    // Mirrors macOS ProgressCardPresentationModel.swift lines 200-208.
    let skillExecuteLabel = "Using a skill";
    if (lastSkillLoad) {
      const skillId = lastSkillLoad.input?.skill;
      if (typeof skillId === "string" && skillId) {
        const display = skillId.replace(/[-_]/g, " ");
        skillExecuteLabel = `Using my ${display} skill`;
      }
    }

    return {
      hasRunning: running,
      hasDenied: denied > 0,
      hasTimeout: timeout,
      deniedCount: denied,
      earliestStart: minStart,
      latestCompleted: maxComplete,
      allCompleted: allDone,
      currentRunningCall: firstRunning,
      firstDeniedCall: firstDenied,
      skillExecuteLabel,
    };
  }, [toolCalls]);

  const phase = computePhase({ hasRunning, allCompleted, hasDenied, isStreaming });

  // Phase-based default: auto-expand while tools are running, thinking, or
  // denied. Collapse only once the card reaches "complete". The persistent
  // expandedCardIds set stores the user's explicit toggle so the preference
  // survives component remounts (e.g. latest-turn → history transition).
  const defaultExpanded = phase !== "complete";
  const persistedState = cardId != null ? expandedCardIds.get(cardId) : undefined;
  const [localExpanded, setLocalExpanded] = useState<boolean | null>(null);
  const expanded = hasActiveConfirmation || (localExpanded ?? (persistedState ?? defaultExpanded));

  // Progressive label for app_create / app_refresh / app_update tools.
  // Only used as a fallback when no server-driven status is available.
  const progressiveLabel = useProgressiveLabel(
    phase === "toolRunning" ? currentRunningCall?.toolName : undefined,
    phase === "toolRunning" ? currentRunningCall?.startedAt : undefined,
  );

  const baseHeadline = computeHeadline(phase, toolCalls.length, deniedCount, currentRunningCall, firstDeniedCall, skillExecuteLabel);
  // Server-driven content (input.reason, input.building_status) takes priority
  // over generic progressive labels. Only fall back to progressive labels when
  // no server-driven headline is available.
  const hasServerDrivenHeadline = phase === "toolRunning" && currentRunningCall && (
    (typeof currentRunningCall.input?.reason === "string" && currentRunningCall.input.reason.trim()) ||
    (typeof currentRunningCall.input?.building_status === "string" && currentRunningCall.input.building_status)
  );
  const headline = (phase === "toolRunning" && progressiveLabel && !hasServerDrivenHeadline)
    ? progressiveLabel
    : baseHeadline;
  const elapsed = useElapsedTime(earliestStart, allCompleted && !isStreaming, latestCompleted, "header");

  return (
    <div className="my-1 w-full">
      {/* Header row */}
      <button
        type="button"
        onClick={() => {
          if (!hasActiveConfirmation && cardId != null) {
            const next = !expanded;
            setLocalExpanded(next);
            expandedCardIds.set(cardId, next);
          }
        }}
        className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-body-medium-default bg-[var(--surface-overlay)] cursor-default ${
          expanded ? "rounded-b-none" : ""
        }`}
      >
        <CardStatusIcon phase={phase} hasDenied={hasDenied} isTimeout={hasTimeout} />
        <span className="shrink-0 text-[var(--content-default)]">
          {headline}
        </span>
        {!expanded && (
          <CollapsedPermissionChips toolCalls={toolCalls} />
        )}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {elapsed && (
            <span className="text-label-small-default text-[var(--content-tertiary)]">
              {elapsed}
            </span>
          )}
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-[var(--content-tertiary)]" />
          ) : (
            <ChevronDown className="h-4 w-4 text-[var(--content-tertiary)]" />
          )}
        </span>
      </button>

      {/* Expanded content: individual tool call chips */}
      {expanded && (
        <div className="space-y-0 rounded-b-lg bg-[var(--surface-overlay)]">
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
                  <div className="flex items-center gap-1 pl-6 text-body-small-default text-[var(--content-tertiary)]">
                    <span>This command wasn&apos;t recognized.</span>
                    <button
                      type="button"
                      onClick={() =>
                        onOpenRuleEditor({
                          toolName: tc.toolName,
                          riskLevel: tc.riskLevel,
                          riskReason: tc.riskReason,
                          input: tc.input ?? {},
                          allowlistOptions: tc.allowlistOptions ?? [],
                          scopeOptions: tc.scopeOptions ?? [],
                          directoryScopeOptions:
                            tc.directoryScopeOptions ?? [],
                        })
                      }
                      // typography: off-scale — inline link within body-small nudge
                       
                      className="font-medium text-[var(--content-default)] underline underline-offset-2 hover:text-[var(--content-secondary)]"
                    >
                      Create a rule
                    </button>
                    <span>to classify it for next time.</span>
                    {onDismissUnknownNudge && (
                      <button
                        type="button"
                        aria-label="Dismiss"
                        onClick={() => onDismissUnknownNudge(tc.id)}
                        className="ml-1 text-[var(--content-disabled)] hover:text-[var(--content-tertiary)]"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )}
              </Fragment>
            );
          })}
          {phase === "thinking" && (
            <ThinkingRow sinceMs={latestCompleted} />
          )}
        </div>
      )}
    </div>
  );
}
