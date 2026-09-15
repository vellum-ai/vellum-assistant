import { resolveRetrospectiveSkillMonitoringContext } from "../../plugins/defaults/memory/memory-retrospective-skill-monitoring.js";
import {
  type MemoryRetrospectiveSkillCandidateDecision,
  type MemoryRetrospectiveSkillSearchOutcome,
  recordMemoryRetrospectiveSkillDecisions,
} from "../../plugins/defaults/memory/memory-retrospective-skill-monitoring-store.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

const OUTCOMES = new Set<MemoryRetrospectiveSkillSearchOutcome>([
  "created",
  "refined",
  "covered",
  "skipped",
]);
const DECISIONS = new Set<MemoryRetrospectiveSkillCandidateDecision>([
  "selected",
  "not_selected",
]);

/** Persist the retrospective's explicit verdict for a similarity shortlist. */
export async function executeRecordRetrospectiveSkillDecision(
  input: Record<string, unknown>,
  context: ToolContext,
  deps: {
    resolveMonitoringContext?: typeof resolveRetrospectiveSkillMonitoringContext;
    recordDecisions?: typeof recordMemoryRetrospectiveSkillDecisions;
  } = {},
): Promise<ToolExecutionResult> {
  const resolveMonitoringContext =
    deps.resolveMonitoringContext ?? resolveRetrospectiveSkillMonitoringContext;
  let monitoringContext: ReturnType<
    typeof resolveRetrospectiveSkillMonitoringContext
  > = null;
  try {
    monitoringContext = resolveMonitoringContext(context);
  } catch {
    // Config or lineage lookup is monitoring-only and must not affect the run.
  }
  if (!monitoringContext) {
    return {
      content:
        "Retrospective skill monitoring is not active for this run. Continue without recording a decision.",
      isError: false,
    };
  }

  const searchId = input.monitoring_search_id;
  if (typeof searchId !== "string" || !searchId.trim()) {
    return {
      content: "Error: monitoring_search_id is required",
      isError: true,
    };
  }
  const outcome = input.outcome;
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome as never)) {
    return {
      content: "Error: outcome must be created, refined, covered, or skipped",
      isError: true,
    };
  }
  const reason = input.reason;
  if (typeof reason !== "string" || !reason.trim()) {
    return { content: "Error: reason is required", isError: true };
  }
  if (!Array.isArray(input.candidates)) {
    return { content: "Error: candidates must be an array", isError: true };
  }

  const candidates: Array<{
    skillId: string;
    decision: MemoryRetrospectiveSkillCandidateDecision;
    reason: string;
  }> = [];
  for (const raw of input.candidates) {
    if (typeof raw !== "object" || raw === null) {
      return {
        content: "Error: each candidate decision must be an object",
        isError: true,
      };
    }
    const row = raw as Record<string, unknown>;
    if (typeof row.skill_id !== "string" || !row.skill_id.trim()) {
      return {
        content: "Error: each candidate decision requires skill_id",
        isError: true,
      };
    }
    if (
      typeof row.decision !== "string" ||
      !DECISIONS.has(row.decision as never)
    ) {
      return {
        content:
          "Error: each candidate decision must be selected or not_selected",
        isError: true,
      };
    }
    if (typeof row.reason !== "string" || !row.reason.trim()) {
      return {
        content: "Error: each candidate decision requires reason",
        isError: true,
      };
    }
    candidates.push({
      skillId: row.skill_id.trim(),
      decision: row.decision as MemoryRetrospectiveSkillCandidateDecision,
      reason: row.reason.trim(),
    });
  }

  try {
    const recordDecisions =
      deps.recordDecisions ?? recordMemoryRetrospectiveSkillDecisions;
    const recorded = recordDecisions({
      searchId: searchId.trim(),
      runConversationId: monitoringContext.runConversationId,
      outcome: outcome as MemoryRetrospectiveSkillSearchOutcome,
      reason: reason.trim(),
      decisions: candidates,
    });
    return {
      content: JSON.stringify({
        recorded,
        monitoring_search_id: searchId.trim(),
      }),
      isError: false,
    };
  } catch {
    return {
      content:
        "Decision evidence could not be persisted. Continue the retrospective without retrying this monitoring call.",
      isError: false,
    };
  }
}
