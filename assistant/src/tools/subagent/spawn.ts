/**
 * subagent_spawn tool — lets the parent LLM spawn an autonomous subagent.
 */

import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { getSubagentManager } from '../../subagent/index.js';

const definition: ToolDefinition = {
  name: 'subagent_spawn',
  description:
    'Spawn an independent subagent to work on a task in parallel. ' +
    'The subagent runs autonomously and its results are reported back when complete.',
  input_schema: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description: 'Short human-readable label for this subagent (e.g. "Research competitor pricing")',
      },
      objective: {
        type: 'string',
        description: 'The task objective — what the subagent should accomplish',
      },
      context: {
        type: 'string',
        description: 'Optional additional context to pass to the subagent',
      },
    },
    required: ['label', 'objective'],
  },
};

export const subagentSpawnTool: Tool = {
  name: 'subagent_spawn',
  description: definition.description,
  category: 'orchestration',
  defaultRiskLevel: RiskLevel.Low,

  getDefinition(): ToolDefinition {
    return definition;
  },

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return executeSubagentSpawn(input, context);
  },
};

export async function executeSubagentSpawn(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const label = input.label as string;
  const objective = input.objective as string;
  const extraContext = input.context as string | undefined;

  if (!label || !objective) {
    return { content: 'Both "label" and "objective" are required.', isError: true };
  }

  const manager = getSubagentManager();
  const sendToClient = context.sendToClient as ((msg: { type: string; [key: string]: unknown }) => void) | undefined;
  if (!sendToClient) {
    return { content: 'No IPC client connected — cannot spawn subagent.', isError: true };
  }

  try {
    const subagentId = await manager.spawn(
      {
        parentSessionId: context.sessionId,
        label,
        objective,
        context: extraContext,
      },
      sendToClient as (msg: unknown) => void,
    );

    return {
      content: JSON.stringify({
        subagentId,
        label,
        status: 'pending',
        message: `Subagent "${label}" spawned. You will be notified automatically when it completes or fails — do NOT poll subagent_status. Continue the conversation normally.`,
      }),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Failed to spawn subagent: ${msg}`, isError: true };
  }
}
