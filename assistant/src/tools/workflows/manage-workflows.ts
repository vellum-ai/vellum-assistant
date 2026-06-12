/**
 * `manage_workflows` core tool — thin reads/controls over
 * {@link WorkflowRunManager}: check a run's status, abort a run, or list recent
 * runs. All state lives in the run manager / journal; this tool only delegates
 * and compacts the result to JSON.
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
        return { content: '"run_id" is required for action "status".', isError: true };
      }
      const run = manager.status(runId);
      if (!run) {
        return { content: JSON.stringify({ runId, found: false }), isError: false };
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
        return { content: '"run_id" is required for action "abort".', isError: true };
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
        content: 'Unknown action. Use one of: "status", "abort", "list_runs".',
        isError: true,
      };
  }
}

export const manageWorkflowsTool = {
  name: "manage_workflows",
  description:
    'Inspect or control workflow runs started by run_workflow. action="status" (requires run_id) returns a run\'s status and counts; action="abort" (requires run_id) signals an in-flight run to stop; action="list_runs" returns recent runs newest-first.',
  // Low risk: status/list are pure reads; abort only signals an existing run to
  // stop and can never spawn work or cause side effects.
  defaultRiskLevel: RiskLevel.Low,
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["status", "abort", "list_runs"],
        description: "What to do.",
      },
      run_id: {
        type: "string",
        description: 'Target run id (required for "status" and "abort").',
      },
    },
    required: ["action"],
  },
  execute: executeManageWorkflows,
} satisfies ToolDefinition;
