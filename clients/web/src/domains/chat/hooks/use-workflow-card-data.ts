/**
 * Builds the `ToolCallCardData` consumed by `InlineProcessCard` via the
 * workflow descriptor, from a single workflow run's store entry. Projects the
 * run's leaves
 * (`WorkflowLeaf[]`) into the unified `ToolCallCardStep[]` shape consumed
 * by the shared tool-progress card chrome — the same shape the subagent
 * inline card uses, so both share one renderer contract.
 *
 * The hook returns `null` when no entry exists for the given run yet —
 * the spawn-race case where the assistant message containing the inline
 * card mounts before the `workflow_started` event lands. The card renders
 * `null` in that window so the transcript layout doesn't jiggle.
 *
 * Leaf-to-step mapping: each leaf becomes a `tool` step, sorted ascending
 * by `seq`. The leaf status maps to the step status (`running` → running,
 * `failed` → error, `completed` → completed). The run status maps to the
 * card `state` (`running` → loading; `completed` → complete; everything
 * terminal-but-not-clean → error).
 */

import { useEffect, useMemo } from "react";

import {
  useWorkflowStore,
  type WorkflowEntry,
  type WorkflowLeaf,
} from "@/domains/chat/workflow-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { isActiveStatus } from "@/utils/workflow-status";
import type { WorkflowRunStatus } from "@vellumai/assistant-api";
import {
  type ToolCallCardData,
  type ToolCallCardStep,
} from "@/domains/chat/utils/tool-call-card-utils";

export type { ToolCallCardData, ToolCallCardStep };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Translate a leaf status to the unified step-status enum. `cancelled`
 * maps to the neutral `completed` terminal so an aborted run's swept
 * leaves don't read as red errors; the `default` shares that terminal
 * fallback so an unmapped status never renders as a perpetual spinner.
 */
function leafStepStatus(
  status: WorkflowLeaf["status"],
): Extract<ToolCallCardStep, { kind: "tool" }>["status"] {
  switch (status) {
    case "running":
      return "running";
    case "failed":
      return "error";
    case "completed":
      return "completed";
    case "cancelled":
      return "completed";
    default:
      return "completed";
  }
}

/**
 * Map a workflow leaf into a `tool` card step. The leaf carries no tool
 * name or icon, so the step uses the workflow-leaf label/prompt summary
 * directly and a neutral icon.
 */
function mapLeafToStep(leaf: WorkflowLeaf): ToolCallCardStep {
  const title = leaf.label ?? `Leaf ${leaf.seq}`;
  const info = leaf.promptSummary ?? "";
  return {
    kind: "tool",
    durationLabel: "",
    toolCallId: String(leaf.seq),
    iconName: "bolt",
    title,
    info,
    activity: "",
    status: leafStepStatus(leaf.status),
  };
}

/**
 * Translate the run status to a shell-compatible visual state. `running`
 * reads as in-flight; `completed` as a clean finish; every other terminal
 * status (`failed`/`aborted`/`cap_exceeded`/`interrupted`) reads as an
 * error so the card doesn't render as a clean completion.
 */
function deriveCardState(status: WorkflowRunStatus): ToolCallCardData["state"] {
  switch (status) {
    case "running":
      return "loading";
    case "completed":
      return "complete";
    case "failed":
    case "aborted":
    case "cap_exceeded":
    case "interrupted":
      return "error";
    default:
      return "loading";
  }
}

/** Leaves sorted ascending by `seq` for stable render order. */
function sortedLeaves(entry: WorkflowEntry): WorkflowLeaf[] {
  return Array.from(entry.leaves.values()).sort((a, b) => a.seq - b.seq);
}

/**
 * Spawned-agent count: prefer the live leaf count, fall back to the run's
 * reported `agentsSpawned`. Shared by the count text and the avatar seeds so
 * the two stay consistent.
 */
function workflowAgentCount(entry: WorkflowEntry): number {
  return entry.leaves.size || entry.agentsSpawned;
}

/**
 * Derive the header `(title, info)` tuple.
 *
 * The bold title is the workflow's *name* (`label`) — stable and
 * recognizable, matching the detail panel header. The card's leading glyph
 * is a generic workflow icon (no avatar), so unlike the subagent inline
 * card — whose identity rides the avatar and whose title is the live
 * activity verb — the workflow card has nowhere else to surface its name;
 * it belongs in the title.
 *
 * While the run is active, the live activity is demoted to the secondary info
 * line so the card still reads as in-flight: the current `phase`, else the
 * latest leaf's prompt summary (or its label), else the latest `log(...)`
 * `message`. (A leaf with neither prompt nor label no longer leaks a
 * `Leaf <seq>` fallback into the header — the row's own list still labels it.)
 *
 * Once the run is terminal, the secondary line reflects the *outcome* — the
 * final `summary` — instead. `completeRun()` leaves the last `entry.phase` set,
 * so without this gate a finished card would keep showing a stale live phase
 * (e.g. "Synthesizing…") rather than the result.
 */
function deriveCurrentStep(
  entry: WorkflowEntry,
  leaves: WorkflowLeaf[],
): { currentStepTitle: string; currentStepInfo: string } {
  const latest = leaves[leaves.length - 1];
  const title = entry.label ?? "Workflow";

  if (!isActiveStatus(entry.status)) {
    return {
      currentStepTitle: title,
      currentStepInfo:
        entry.summary ||
        entry.message ||
        latest?.resultSummary ||
        latest?.promptSummary ||
        latest?.label ||
        "",
    };
  }

  return {
    currentStepTitle: title,
    currentStepInfo:
      entry.phase ||
      latest?.promptSummary ||
      latest?.label ||
      entry.message ||
      "",
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pure projection of (entry) → card props. Split from the hook so tests
 * can drive it without instantiating the Zustand store.
 */
export function computeWorkflowCardData(
  entry: WorkflowEntry,
): ToolCallCardData {
  const leaves = sortedLeaves(entry);
  const steps = leaves.map(mapLeafToStep);

  const state = deriveCardState(entry.status);
  const { currentStepTitle, currentStepInfo } = deriveCurrentStep(
    entry,
    leaves,
  );

  // Step count reflects spawned agents, not generic "steps".
  const count = workflowAgentCount(entry);
  const stepCount = `${count} agent${count === 1 ? "" : "s"}`;

  return {
    state,
    currentStepTitle,
    currentStepInfo,
    stepCount,
    steps,
    // Workflow cards don't use the web-search carousel.
    carouselItems: [],
  };
}

/**
 * Max avatars rendered in the workflow card's spawned-agent stack. Matches
 * the Figma 3-avatar sample; the count text carries the total.
 */
const MAX_VISIBLE_WORKFLOW_AGENT_AVATARS = 3;

/** Stable empty seed array so the hook returns a constant ref for unknown runs. */
const EMPTY_SEEDS: string[] = [];

/**
 * Derive stable avatar seeds for a run's spawned agents. The count comes from
 * the shared `workflowAgentCount` helper (same as the card's count text) so
 * avatars and the count stay consistent. Live runs seed from the sorted
 * leaves' `seq`; a
 * hydrated count-only run (no per-leaf events) synthesizes index seeds. Each
 * seed is a stable `${runId}:${seq}` string.
 */
export function selectWorkflowAgentAvatarSeeds(entry: WorkflowEntry): string[] {
  const visible = Math.min(
    workflowAgentCount(entry),
    MAX_VISIBLE_WORKFLOW_AGENT_AVATARS,
  );

  const seqs =
    entry.leaves.size > 0
      ? sortedLeaves(entry)
          .slice(0, visible)
          .map((l) => l.seq)
      : Array.from({ length: visible }, (_, i) => i);

  return seqs.map((seq) => `${entry.runId}:${seq}`);
}

/**
 * React hook: subscribe to the workflow store entry for `runId` and derive
 * its spawned-agent avatar seeds. Selecting the stable `entry` ref then
 * deriving in `useMemo` avoids returning a fresh array every render (which
 * would loop a consumer's effects). Returns a constant empty array when no
 * entry exists yet.
 */
export function useWorkflowAgentAvatarSeeds(runId: string): string[] {
  const entry = useWorkflowStore((state) => state.byId[runId]);
  return useMemo(
    () => (entry ? selectWorkflowAgentAvatarSeeds(entry) : EMPTY_SEEDS),
    [entry],
  );
}

/**
 * React hook: subscribe to the workflow store entry for `runId` and
 * project it into `ToolCallCardData`. Returns `null` when no entry exists
 * yet (spawn race, or a history / post-reload card before hydration), so
 * callers can short-circuit rendering.
 *
 * When the store has no entry, hydrates the run on demand from its row +
 * journal. History and post-reload cards recover their runId from a
 * persisted `run_workflow` tool result but get no live `workflow_started`
 * event, so without this they would render `null` forever. Once hydration
 * populates the store the subscription re-renders the card — the same
 * settle-after-the-fact path as the spawn race.
 */
export function useWorkflowCardData(runId: string): ToolCallCardData | null {
  const entry = useWorkflowStore((state) => state.byId[runId]);
  const assistantId = useResolvedAssistantsStore((s) => s.activeAssistantId);

  useEffect(() => {
    if (!entry && assistantId) {
      void useWorkflowStore.getState().hydrateRunIfNeeded(assistantId, runId);
    }
  }, [entry, assistantId, runId]);

  return useMemo(() => {
    if (!entry) return null;
    return computeWorkflowCardData(entry);
  }, [entry]);
}
