import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { getConfig } from '../../config/loader.js';
import { getLogger } from '../../util/logger.js';
import { getProvider } from '../../providers/registry.js';
import { resolveSwarmLimits } from '../../swarm/limits.js';
import { generatePlan } from '../../swarm/router-planner.js';
import { executeSwarm } from '../../swarm/orchestrator.js';
import type { SwarmWorkerBackend, SwarmWorkerBackendInput } from '../../swarm/worker-backend.js';
import { getProfilePolicy } from '../../swarm/worker-backend.js';

const log = getLogger('swarm-delegate');

/** Tracks active swarm sessions to prevent nested invocation per-session. */
const activeSessions = new Set<string>();

/**
 * Claude Code worker backend adapter that enforces profile-based tool policies.
 * Uses the same canUseTool pattern as the claude_code tool.
 */
function createClaudeCodeBackend(): SwarmWorkerBackend {
  return {
    name: 'claude_code',

    isAvailable(): boolean {
      const config = getConfig();
      const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
      return !!apiKey;
    },

    async runTask(input: SwarmWorkerBackendInput) {
      const start = Date.now();
      try {
        const { query } = await import('@anthropic-ai/claude-agent-sdk');
        const config = getConfig();
        const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          return { success: false, output: 'No API key', failureReason: 'backend_unavailable' as const, durationMs: 0 };
        }

        const profilePolicy = getProfilePolicy(input.profile);

        // Enforce profile restrictions — swarm workers run autonomously so
        // there is no user to prompt; denied tools are blocked, everything
        // else is allowed.
        const canUseTool: import('@anthropic-ai/claude-agent-sdk').CanUseTool = async (toolName) => {
          if (profilePolicy.deny.has(toolName)) {
            log.debug({ toolName, profile: input.profile }, 'Swarm worker tool denied by profile');
            return { behavior: 'deny' as const, message: `Tool "${toolName}" is denied by profile "${input.profile}"` };
          }
          return { behavior: 'allow' as const };
        };

        const conversation = query({
          prompt: input.prompt,
          options: {
            cwd: input.workingDir,
            model: input.model ?? 'claude-sonnet-4-5-20250929',
            canUseTool,
            permissionMode: 'default',
            maxTurns: 30,
            env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
          },
        });

        let resultText = '';
        for await (const message of conversation) {
          if (input.signal?.aborted) break;
          if (message.type === 'assistant' && message.message?.content) {
            for (const block of message.message.content) {
              if (block.type === 'text') resultText += block.text;
            }
          } else if (message.type === 'result') {
            if (message.subtype === 'success' && message.result && !resultText) {
              resultText = message.result;
            }
          }
        }

        return { success: true, output: resultText || 'Completed', durationMs: Date.now() - start };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: message, failureReason: 'backend_unavailable' as const, durationMs: Date.now() - start };
      }
    },
  };
}

export const swarmDelegateTool: Tool = {
  name: 'swarm_delegate',
  description: 'Decompose a complex task into parallel specialist subtasks and execute them concurrently. Use this for multi-part tasks that benefit from parallel research, coding, and review.',
  category: 'orchestration',
  defaultRiskLevel: RiskLevel.Medium,

  getDefinition(): ToolDefinition {
    return {
      name: 'swarm_delegate',
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          objective: {
            type: 'string',
            description: 'The complex task to decompose and execute in parallel',
          },
          context: {
            type: 'string',
            description: 'Optional additional context about the task or codebase',
          },
          max_workers: {
            type: 'number',
            description: 'Maximum concurrent workers (1-6, default from config)',
          },
        },
        required: ['objective'],
      },
    };
  },

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const objective = input.objective as string;
    const extraContext = input.context as string | undefined;
    const maxWorkersOverride = input.max_workers as number | undefined;

    // Check if swarm is enabled
    const config = getConfig();
    if (!config.swarm.enabled) {
      return {
        content: 'Swarm orchestration is disabled in config (swarm.enabled = false). Execute the task directly instead.',
        isError: false,
      };
    }

    // Early abort check
    if (context.signal?.aborted) {
      return { content: 'Cancelled', isError: true };
    }

    // Recursion guard — scoped to session so independent sessions are not blocked
    const sessionKey = context.sessionId;
    if (activeSessions.has(sessionKey)) {
      return {
        content: 'Error: A swarm is already executing in this session. Nested swarm invocation is not allowed.',
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
      });

      // Generate plan
      context.onOutput?.('Planning task decomposition...\n');
      const planProvider = getProvider(config.provider);
      const plan = await generatePlan({
        objective: extraContext ? `${objective}\n\nContext: ${extraContext}` : objective,
        provider: planProvider,
        model: config.swarm.plannerModel,
        limits,
      });

      context.onOutput?.(`Plan: ${plan.tasks.length} tasks\n`);
      for (const task of plan.tasks) {
        context.onOutput?.(`  - [${task.role}] ${task.id}: ${task.objective.slice(0, 80)}\n`);
      }
      context.onOutput?.('\nExecuting...\n');

      // Check abort before starting execution
      if (context.signal?.aborted) {
        return { content: 'Cancelled before execution', isError: true };
      }

      // Execute
      const backend = createClaudeCodeBackend();
      let synthesisProvider: typeof planProvider | undefined;
      try {
        synthesisProvider = getProvider(config.provider);
      } catch {
        // No provider available for synthesis — will use fallback
      }

      const summary = await executeSwarm({
        plan,
        limits,
        backend,
        workingDir: context.workingDir,
        model: config.swarm.plannerModel,
        synthesisProvider,
        synthesisModel: config.swarm.synthesizerModel,
        signal: context.signal,
        onStatus: (event) => {
          switch (event.kind) {
            case 'task_started':
              context.onOutput?.(`[START] ${event.taskId}\n`);
              break;
            case 'task_completed':
              context.onOutput?.(`[DONE]  ${event.taskId}\n`);
              break;
            case 'task_failed':
              context.onOutput?.(`[FAIL]  ${event.taskId}\n`);
              break;
            case 'task_blocked':
              context.onOutput?.(`[BLOCK] ${event.taskId}\n`);
              break;
            case 'done':
              context.onOutput?.(`\nSwarm completed.\n`);
              break;
          }
        },
      });

      // Format result
      const lines: string[] = [];
      lines.push(summary.finalAnswer);
      lines.push('');
      lines.push(`---`);
      lines.push(`Tasks: ${summary.stats.completed} completed, ${summary.stats.failed} failed, ${summary.stats.blocked} blocked`);
      lines.push(`Duration: ${summary.stats.totalDurationMs}ms`);

      if (summary.stats.failed > 0 || summary.stats.blocked > 0) {
        lines.push('');
        lines.push('### Issues');
        for (const r of summary.results) {
          if (r.status === 'failed') {
            lines.push(`- **${r.taskId}** (failed): ${r.summary}`);
          }
        }
      }

      return {
        content: lines.join('\n'),
        isError: summary.stats.completed === 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'Swarm execution failed');
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
