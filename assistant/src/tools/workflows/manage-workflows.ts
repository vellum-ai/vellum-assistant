/**
 * `manage_workflows` core tool — thin reads/controls over
 * {@link WorkflowRunManager}: check a run's status, abort a run, or list recent
 * runs. All state lives in the run manager / journal; this tool only delegates
 * and compacts the result to JSON.
 *
 * NOTE: this tool runs in-process and returns a `runId`-keyed, deliberately
 * trimmed projection for the model — a DIFFERENT contract from the HTTP wire
 * shape (`id`-keyed `toWireRun`/`workflowRunSchema` in
 * `runtime/routes/workflow-routes.ts`). The two are intentionally not unified:
 * converging on `toWireRun` here would change this tool's emitted JSON. Both
 * project from the same `WorkflowRun` source type, so field renames are caught
 * by the type checker.
 */

import { callerOwnsWorkflowRun } from "../../workflows/capabilities.js";
import type { WorkflowRun } from "../../workflows/journal-store.js";
import { getWorkflowRunManager } from "../../workflows/run-manager.js";
import {
  RiskLevel,
  type ToolContext,
  type ToolDefinition,
  type ToolExecutionResult,
} from "../types.js";

async function executeManageWorkflows(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const action = input.action as string | undefined;
  const runId = input.run_id as string | undefined;
  const manager = getWorkflowRunManager();

  // Authorization scope ({@link callerOwnsWorkflowRun}, shared with the
  // executor's resume-approval gate): a guardian may inspect/control every run,
  // but a non-guardian conversation is limited to runs IT originated. Without
  // this, a contact could enumerate a guardian's workflows (names/statuses) via
  // list_runs and then abort/resume them by id — the tool is low-risk and
  // reachable in non-guardian conversations. A run the caller may not see is
  // treated as not-found so the tool never reveals another conversation's run.
  const ownsRun = (run: WorkflowRun): boolean =>
    callerOwnsWorkflowRun(run, context);

  switch (action) {
    case "status": {
      if (!runId) {
        return {
          content: '"run_id" is required for action "status".',
          isError: true,
        };
      }
      const run = manager.status(runId);
      if (!run || !ownsRun(run)) {
        return {
          content: JSON.stringify({ runId, found: false }),
          isError: false,
        };
      }
      return {
        content: JSON.stringify({
          runId: run.id,
          name: run.name,
          status: run.status,
          agentsSpawned: run.agentsSpawned,
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          error: run.error,
        }),
        isError: false,
      };
    }
    case "abort": {
      if (!runId) {
        return {
          content: '"run_id" is required for action "abort".',
          isError: true,
        };
      }
      // Only signal a run the caller owns. A non-owned (or absent) run is a
      // no-op with the same response shape, so existence is never revealed.
      const run = manager.status(runId);
      if (run && ownsRun(run)) manager.abort(runId);
      return {
        content: JSON.stringify({
          runId,
          message: "Abort signalled (no-op if the run already finished).",
        }),
        isError: false,
      };
    }
    case "resume": {
      if (!runId) {
        return {
          content: '"run_id" is required for action "resume".',
          isError: true,
        };
      }
      // Don't resume — or reveal — a run the caller doesn't own; mirror
      // resume()'s own not-found message.
      const run = manager.status(runId);
      if (!run || !ownsRun(run)) {
        return {
          content: `Failed to resume workflow: Workflow run ${runId} not found.`,
          isError: true,
        };
      }
      try {
        const { runId: resumedId } = manager.resume(runId);
        return {
          content: JSON.stringify({
            runId: resumedId,
            status: "running",
            message:
              "Workflow resumed. The completed prefix is replayed from the journal and the run continues from the first unfinished step. You will be notified in this conversation when it completes — do NOT poll.",
          }),
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `Failed to resume workflow: ${msg}`, isError: true };
      }
    }
    case "list_runs": {
      const runs = manager.list().filter(ownsRun);
      return {
        content: JSON.stringify({
          runs: runs.map((r) => ({
            runId: r.id,
            name: r.name,
            status: r.status,
            agentsSpawned: r.agentsSpawned,
          })),
        }),
        isError: false,
      };
    }
    default:
      return {
        content:
          'Unknown action. Use one of: "status", "abort", "resume", "list_runs".',
        isError: true,
      };
  }
}

export const manageWorkflowsTool = {
  name: "manage_workflows",
  description:
    'Inspect or control workflow runs started by run_workflow. action="status" (requires run_id) returns a run\'s status and counts; action="abort" (requires run_id) signals an in-flight run to stop; action="resume" (requires run_id) restarts an interrupted run (one orphaned by an assistant restart), replaying its journaled prefix and continuing from the first unfinished step; action="list_runs" returns recent runs newest-first.',
  // Low risk by default: status/list are pure reads; abort only signals an
  // existing run to stop; resuming a READ-ONLY run replays a journaled prefix
  // and continues under the same structural agent cap. Resuming a run whose
  // STORED manifest granted side-effecting tools/host functions is promoted to
  // require fresh interactive approval in the executor (see executor.ts) —
  // resume restarts unfinished side-effecting leaves and is reachable by any
  // actor who can list/guess the run id, so it must not silently reuse the
  // launch-time consent.
  defaultRiskLevel: RiskLevel.Low,
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["status", "abort", "resume", "list_runs"],
        description: "What to do.",
      },
      run_id: {
        type: "string",
        description:
          'Target run id (required for "status", "abort", and "resume").',
      },
    },
    required: ["action"],
  },
  execute: executeManageWorkflows,
} satisfies ToolDefinition;
