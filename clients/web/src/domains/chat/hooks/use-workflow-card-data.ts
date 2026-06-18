/**
 * Builds the props for `WorkflowInlineProgressCard` from a single
 * workflow run's store entry. Projects the run's leaves
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
 * Derive the header `(title, info)` tuple. When the run carries a `phase`
 * we surface it; otherwise we fall back to the latest leaf (the deepest
 * `seq`), and finally to the run label. The latest `log(...)` `message`
 * fills the secondary line when there is no more-specific leaf info or
 * phase, so a log-only update doesn't read as stale.
 */
function deriveCurrentStep(
  entry: WorkflowEntry,
  leaves: WorkflowLeaf[],
): { currentStepTitle: string; currentStepInfo: string } {
  if (entry.phase) {
    return {
      currentStepTitle: entry.phase,
      currentStepInfo: entry.summary ?? entry.message ?? entry.label ?? "",
    };
  }

  const latest = leaves[leaves.length - 1];
  if (latest) {
    return {
      currentStepTitle: latest.label ?? `Leaf ${latest.seq}`,
      currentStepInfo: latest.promptSummary ?? "",
    };
  }

  return {
    currentStepTitle: entry.label ?? "Workflow",
    currentStepInfo: entry.message ?? entry.summary ?? "",
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

  // Step count reflects spawned agents, not generic "steps". Prefer the
  // live leaf count, falling back to the run's reported `agentsSpawned`.
  const count = entry.leaves.size || entry.agentsSpawned;
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
