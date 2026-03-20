import { getConfig } from "../../config/loader.js";
import { RiskLevel } from "../../permissions/types.js";
import { getFailoverProvider } from "../../providers/registry.js";
import type { ToolDefinition } from "../../providers/types.js";
import { resolveSwarmLimits } from "../../swarm/limits.js";
import { generatePlan } from "../../swarm/router-planner.js";
import { getLogger } from "../../util/logger.js";
import { truncate } from "../../util/truncate.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

const log = getLogger("swarm-delegate");

/** Tracks active swarm conversations to prevent nested invocation per-conversation. */
const activeConversations = new Set<string>();

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

    // Recursion guard - scoped to conversation so independent conversations are not blocked
    const conversationKey = context.conversationId;
    if (activeConversations.has(conversationKey)) {
      return {
        content:
          "Error: A swarm is already executing in this conversation. Nested swarm invocation is not allowed.",
        isError: true,
      };
    }

    activeConversations.add(conversationKey);
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
        config.services.inference.provider,
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

      return {
        content:
          "Swarm orchestration is currently unavailable: no worker backend is configured.",
        isError: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Swarm execution failed");
      return {
        content: `Swarm error: ${message}`,
        isError: true,
      };
    } finally {
      activeConversations.delete(conversationKey);
    }
  },
};

/** Clear all active conversations - only for testing. */
export function _resetSwarmActive(): void {
  activeConversations.clear();
}
