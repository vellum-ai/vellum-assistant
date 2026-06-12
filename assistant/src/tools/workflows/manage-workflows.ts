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

import { getWorkflowRunManager } from "../../workflows/run-manager.js";
import {
  RiskLevel,
  type ToolContext,
  type ToolDefinition,
  type ToolExecutionResult,
} from "../types.js";

async function executeManageWorkflows(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const action = input.action as string | undefined;
  const runId = input.run_id as string | undefined;
  const manager = getWorkflowRunManager();

  switch (action) {
    case "status": {
      if (!runId) {
        return {
          content: '"run_id" is required for action "status".',
          isError: true,
        };
      }
      const run = manager.status(runId);
      if (!run) {
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
      manager.abort(runId);
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
      const runs = manager.list();
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
  // Low risk: status/list are pure reads; abort only signals an existing run to
  // stop; resume replays a journaled prefix and continues a previously-consented
  // run under the same structural agent cap — none can introduce new unbounded
  // work or side effects beyond what the run already declared.
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
