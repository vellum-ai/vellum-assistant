import { getConfig } from "../../config/loader.js";
import { RiskLevel } from "../../permissions/types.js";
import { getFailoverProvider } from "../../providers/registry.js";
import type { ToolDefinition } from "../../providers/types.js";
import { createClaudeCodeBackend } from "../../swarm/backend-claude-code.js";
import { resolveSwarmLimits } from "../../swarm/limits.js";
import { executeSwarm } from "../../swarm/orchestrator.js";
import { generatePlan } from "../../swarm/router-planner.js";
import { getLogger } from "../../util/logger.js";
import { truncate } from "../../util/truncate.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

const log = getLogger("swarm-delegate");

/** Tracks active swarm sessions to prevent nested invocation per-session. */
const activeSessions = new Set<string>();

export const swarmDelegateTool: Tool = {
  name: "swarm_delegate",
  description:
    "Decompose a complex task into parallel specialist subtasks and execute them concurrently. Use this for multi-part tasks that benefit from parallel research, coding, and review.",
  category: "orchestration",
  defaultRiskLevel: RiskLevel.Medium,

  getDefinition(): ToolDefinition {
    return {
      name: "swarm_delegate",
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          objective: {
            type: "string",
            description:
              "The complex task to decompose and execute in parallel",
          },
          context: {
            type: "string",
            description:
              "Optional additional context about the task or codebase",
          },
          max_workers: {
            type: "number",
            description:
              "Maximum concurrent workers (1-6, default from config)",
          },
        },
        required: ["objective"],
      },
    };
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const objective = input.objective as string;
    const extraContext = input.context as string | undefined;
    const maxWorkersOverride = input.max_workers as number | undefined;

    // Check if swarm is enabled
    const config = getConfig();
    if (!config.swarm.enabled) {
      return {
        content:
          "Swarm orchestration is disabled in config (swarm.enabled = false). Execute the task directly instead.",
        isError: false,
      };
    }

    // Early abort check
    if (context.signal?.aborted) {
      return { content: "Cancelled", isError: true };
    }

    // Recursion guard — scoped to session so independent sessions are not blocked
    const sessionKey = context.conversationId;
    if (activeSessions.has(sessionKey)) {
      return {
        content:
          "Error: A swarm is already executing in this session. Nested swarm invocation is not allowed.",
        isError: true,
      };
    }

    activeSessions.add(sessionKey);
    try {
      const limits = resolveSwarmLimits({
        maxWorkers: maxWorkersOverride ?? config.swarm.maxWorkers,
        maxTasks: config.swarm.maxTasks,
        maxRetriesPerTask: config.swarm.maxRetriesPerTask,
        workerTimeoutSec: config.swarm.workerTimeoutSec,
        roleTimeoutsSec: config.swarm.roleTimeoutsSec,
      });

      // Generate plan
      context.onOutput?.("Planning task decomposition...\n");
      const planProvider = getFailoverProvider(
        config.provider,
        config.providerOrder,
      );
      const plan = await generatePlan({
        objective: extraContext
          ? `${objective}\n\nContext: ${extraContext}`
          : objective,
        provider: planProvider,
        modelIntent: config.swarm.plannerModelIntent,
        limits,
      });

      context.onOutput?.(`Plan: ${plan.tasks.length} tasks\n`);
      for (const task of plan.tasks) {
        context.onOutput?.(
          `  - [${task.role}] ${task.id}: ${truncate(task.objective, 80)}\n`,
        );
      }
      context.onOutput?.("\nExecuting...\n");

      if (context.signal?.aborted) {
        return { content: "Cancelled before execution", isError: true };
      }

      // Execute
      const backend = createClaudeCodeBackend();
      let synthesisProvider: typeof planProvider | undefined;
      try {
        synthesisProvider = getFailoverProvider(
          config.provider,
          config.providerOrder,
        );
      } catch {
        // No provider available for synthesis — will use fallback
      }

      const summary = await executeSwarm({
        plan,
        limits,
        backend,
        workingDir: context.workingDir,
        modelIntent: config.swarm.synthesizerModelIntent,
        synthesisProvider,
        synthesisModelIntent: config.swarm.synthesizerModelIntent,
        signal: context.signal,
        onStatus: (event) => {
          switch (event.kind) {
            case "task_started":
              context.onOutput?.(`[START] ${event.taskId}\n`);
              break;
            case "task_completed":
              context.onOutput?.(`[DONE]  ${event.taskId}\n`);
              break;
            case "task_failed":
              context.onOutput?.(`[FAIL]  ${event.taskId}\n`);
              break;
            case "task_blocked":
              context.onOutput?.(`[BLOCK] ${event.taskId}\n`);
              break;
            case "done":
              context.onOutput?.(`\nSwarm completed.\n`);
              break;
          }
        },
      });

      // Format result
      const lines: string[] = [];
      lines.push(summary.finalAnswer);
      lines.push("");
      lines.push(`---`);
      lines.push(
        `Tasks: ${summary.stats.completed} completed, ${summary.stats.failed} failed, ${summary.stats.blocked} blocked`,
      );
      lines.push(`Duration: ${summary.stats.totalDurationMs}ms`);

      if (summary.stats.failed > 0 || summary.stats.blocked > 0) {
        lines.push("");
        lines.push("### Issues");
        for (const r of summary.results) {
          if (r.status === "failed") {
            lines.push(`- **${r.taskId}** (failed): ${r.summary}`);
          }
        }
      }

      return {
        content: lines.join("\n"),
        isError: summary.stats.completed === 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Swarm execution failed");
      return {
        content: `Swarm error: ${message}`,
        isError: true,
      };
    } finally {
      activeSessions.delete(sessionKey);
    }
  },
};

/** Clear all active sessions — only for testing. */
export function _resetSwarmActive(): void {
  activeSessions.clear();
}
