/**
 * Builds the `ToolCallCardData` consumed by `InlineProcessCard` via the acp-run
 * descriptor, from a single ACP run's store entry. Projects the run's raw event
 * buffer into the carousel via `useAcpRunSteps` + `acpStepsToCarousel`, then
 * maps the run status to the shared card props consumed by the tool-progress
 * card chrome — the same shape the workflow and subagent inline cards feed their
 * shells.
 *
 * Returns `null` when no entry exists for the given session yet — the
 * spawn-race window where the assistant message containing the inline card
 * mounts a hair before the `acp_session_spawned` event lands. The card renders
 * `null` in that window so the transcript layout doesn't jiggle, mirroring
 * `useWorkflowCardData`.
 *
 * Visual-state mapping lives in `deriveCardState`.
 */

import { useMemo } from "react";

import {
  acpStepsToCarousel,
  useAcpRunSteps,
  type AcpTimelineStep,
} from "@/domains/chat/acp-run-step-projection";
import { useAcpRunStore, type AcpRunRawEvent } from "@/domains/chat/acp-run-store";
import type { AcpRunStatus } from "@/utils/acp-run-status";
import type { ToolProgressCardState } from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell";

/**
 * Stable shared empty buffer for the spawn-race window (no entry yet). A stable
 * reference keeps the projector's identity check happy so the hook doesn't
 * churn while waiting for the spawn event.
 */
const EMPTY_EVENTS: AcpRunRawEvent[] = [];

export interface AcpRunCardData {
  state: ToolProgressCardState;
  currentStepTitle: string;
  currentStepInfo: string;
  /** Pre-formatted tool-step count, e.g. `"2 steps"`. */
  stepCount: string;
  /** Backing agent (e.g. "claude", "codex") — drives the brand glyph. */
  agent: string;
}

/**
 * Translate the run status to a shell-compatible visual state. A `completed`
 * run that was cancelled reads as a `warning` (partial work).
 */
function deriveCardState(
  status: AcpRunStatus,
  stopReason: string | undefined,
): ToolProgressCardState {
  switch (status) {
    case "initializing":
    case "running":
      return "loading";
    case "completed":
      return stopReason === "cancelled" ? "warning" : "complete";
    case "failed":
    case "cancelled":
      return "error";
    default:
      return "loading";
  }
}

/**
 * Secondary descriptor for the header — the detail of the latest projected
 * step (tool title, message/thought content). Empty when the latest step
 * carries nothing useful (its carousel label already says it all).
 */
function deriveCurrentStepInfo(steps: AcpTimelineStep[]): string {
  const latest = steps[steps.length - 1];
  if (!latest) return "";
  switch (latest.kind) {
    case "tool":
      // The title already drives `currentStepTitle`; repeating it duplicates.
      return "";
    case "message":
    case "thought":
      return latest.content;
    case "plan":
      return "";
  }
}

/**
 * React hook: subscribe to the ACP run store entry for `acpSessionId` and
 * project it into card props. Returns `null` when no entry exists yet (spawn
 * race) so callers can short-circuit rendering.
 */
export function useAcpRunCardData(acpSessionId: string): AcpRunCardData | null {
  const entry = useAcpRunStore((s) => s.byId[acpSessionId]);
  // Project incrementally (must run unconditionally — `useAcpRunSteps` holds a
  // ref). In the spawn-race window there's no entry yet, so feed the stable
  // empty buffer; the `null` return below preserves the contract.
  const steps = useAcpRunSteps(entry?.events ?? EMPTY_EVENTS);

  return useMemo(() => {
    if (!entry) return null;

    const carousel = acpStepsToCarousel(steps);
    const latest = carousel[carousel.length - 1];
    // Step count reflects tool steps only — message/thought/plan steps are
    // chatter, not discrete "steps" the run progressed through.
    const toolStepCount = steps.reduce(
      (n, step) => (step.kind === "tool" ? n + 1 : n),
      0,
    );

    return {
      state: deriveCardState(entry.status, entry.stopReason),
      currentStepTitle: latest?.label ?? "Working",
      currentStepInfo: deriveCurrentStepInfo(steps),
      stepCount: `${toolStepCount} step${toolStepCount === 1 ? "" : "s"}`,
      agent: entry.agent,
    };
  }, [entry, steps]);
}
