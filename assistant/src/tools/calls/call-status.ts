import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { getCallStatus } from '../../calls/call-domain.js';

const definition: ToolDefinition = {
  name: 'call_status',
  description: 'Check the status of an active or recent phone call',
  input_schema: {
    type: 'object',
    properties: {
      call_session_id: {
        type: 'string',
        description: 'Specific call session ID to check. If omitted, checks for an active call in the current conversation.',
      },
    },
    required: [],
  },
};

class CallStatusTool implements Tool {
  name = 'call_status';
  description = definition.description;
  category = 'communication';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const callSessionId = input.call_session_id as string | undefined;

    const result = getCallStatus(callSessionId, context.conversationId);

    if (!result.ok) {
      // When no active call is found and no specific ID was requested, it's not an error
      if (!callSessionId && result.error === 'No active call found in the current conversation') {
        return { content: result.error, isError: false };
      }
      return { content: `Error: ${result.error}`, isError: true };
    }

    const { session } = result;
    const lines = [
      `Call Session: ${session.id}`,
      `  Status: ${session.status}`,
      `  To: ${session.toNumber}`,
      `  From: ${session.fromNumber}`,
    ];

    if (session.providerCallSid) {
      lines.push(`  Call SID: ${session.providerCallSid}`);
    }

    if (session.task) {
      lines.push(`  Task: ${session.task}`);
    }

    if (session.startedAt) {
      const durationMs = (session.endedAt ?? Date.now()) - session.startedAt;
      const durationSec = Math.round(durationMs / 1000);
      lines.push(`  Duration: ${durationSec}s`);
    }

    if (session.lastError) {
      lines.push(`  Last Error: ${session.lastError}`);
    }

    if (result.pendingQuestion) {
      lines.push('');
      lines.push(`  Pending Question: ${result.pendingQuestion.questionText}`);
      lines.push(`  Question ID: ${result.pendingQuestion.id}`);
    }

    return { content: lines.join('\n'), isError: false };
  }
}

registerTool(new CallStatusTool());
