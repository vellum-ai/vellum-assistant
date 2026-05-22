
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";

import { BusyIndicator } from "@/domains/chat/components/busy-indicator.js";
import { ToolCallChip } from "@/domains/chat/components/tool-call-chip/tool-call-chip.js";
import {
  extractInputSummary,
  friendlyRunningLabel,
  progressiveLabels,
} from "@/domains/chat/components/tool-call-chip/utils.js";
import { WebSearchProgressCard } from "@/domains/chat/components/web-search/web-search-progress-card.js";
import { useElapsedTime } from "@/domains/chat/hooks/use-elapsed-time.js";
import { useWebSearchCardData } from "@/domains/chat/hooks/use-web-search-card-data.js";
import type { AllowlistOption, ChatMessageToolCall, ConfirmationDecision, DirectoryScopeOption, ScopeOption } from "@/domains/chat/api/event-types.js";

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
// Stall watchdog
// ---------------------------------------------------------------------------

/** Threshold (ms) after which the client considers events stalled. */
const CLIENT_STALL_THRESHOLD_MS = 45_000;

/**
 * When tool_progress events report a long-running tool, return a user-friendly
 * "still working" message. Also acts as a client-side stall watchdog: if a
 * tool has been running >45s with no progress event at all, or the last
 * progress event is >45s stale, show a stall indicator.
 */
function stallSuffix(
  tc: ChatMessageToolCall | undefined,
  now: number,
): string | null {
  if (!tc || tc.status !== "running") return null;

  // Server-driven progress: the daemon sends tool_progress every ~10s
  if (tc.progressElapsedSec != null && tc.progressElapsedSec >= 30) {
    if (tc.progressElapsedSec >= 60) return "This is taking longer than expected...";
    return "Still working...";
  }

  // Client-side stall watchdog: no tool_progress events received but
  // the tool has been running longer than the stall threshold.
  if (tc.startedAt != null) {
    const runningMs = now - tc.startedAt;
    if (runningMs >= CLIENT_STALL_THRESHOLD_MS) {
      // If we had progress events but they stopped arriving, that's a stall
      if (tc.lastProgressAt != null) {
        const sinceLast = now - tc.lastProgressAt;
        if (sinceLast >= CLIENT_STALL_THRESHOLD_MS) {
          return "Connection may be interrupted...";
        }
      } else {
        // No progress events ever received — server may not support them,
        // but tool has been running a long time
        if (runningMs >= 60_000) return "This is taking longer than expected...";
        return "Still working...";
      }
    }
  }

  return null;
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

export function ToolCallProgressCard(props: ToolCallProgressCardProps) {
  // Short-circuit to the new web-search progress card whenever the active
  // turn has any `web_search` / `web_fetch` tool calls. The selector hook
  // returns `null` for non-web tool calls and historical (reopened) turns —
  // those continue through the legacy generic card rendering below.
  //
  // The legacy renderer is its own component so the conditional return
  // doesn't sit in front of the legacy path's hook calls (rules-of-hooks).
  const webSearchData = useWebSearchCardData(props.toolCalls);
  if (webSearchData) {
    return (
      <WebSearchProgressCard
        currentStepTitle={webSearchData.currentStepTitle}
        currentStepInfo={webSearchData.currentStepInfo}
        stepCount={webSearchData.stepCount}
        steps={webSearchData.steps}
        state={webSearchData.state}
        carouselItems={webSearchData.carouselItems}
      />
    );
  }
  return <LegacyToolCallProgressCard {...props} />;
}

function LegacyToolCallProgressCard({
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

  // Tick every 5s while tools are running so stallSuffix can detect
  // client-side stalls even when no SSE events are flowing. Stops ticking
  // once all tools complete.
  const [stallNow, setStallNow] = useState(Date.now);
  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setStallNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, [hasRunning]);

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
  // When a tool_progress event reports a stall (>=30s), override the headline
  // with a user-friendly "still working" message. This takes highest priority
  // so the user always sees feedback during long-running tool executions.
  const stall = phase === "toolRunning" ? stallSuffix(currentRunningCall, stallNow) : null;
  const headline = stall
    ? stall
    : (phase === "toolRunning" && progressiveLabel && !hasServerDrivenHeadline)
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
