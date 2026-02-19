import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { cancelCall } from '../../calls/call-domain.js';

const definition: ToolDefinition = {
  name: 'call_end',
  description: 'End an active phone call',
  input_schema: {
    type: 'object',
    properties: {
      call_session_id: {
        type: 'string',
        description: 'The call session ID to end',
      },
      reason: {
        type: 'string',
        description: 'Reason for ending the call',
      },
    },
    required: ['call_session_id'],
  },
};

class CallEndTool implements Tool {
  name = 'call_end';
  description = definition.description;
  category = 'communication';
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const callSessionId = input.call_session_id as string | undefined;
    if (!callSessionId || typeof callSessionId !== 'string') {
      return { content: 'Error: call_session_id is required and must be a string', isError: true };
    }

    const reason = input.reason as string | undefined;

    const result = await cancelCall({ callSessionId, reason });

    if (!result.ok) {
      // If the call already ended, report it as a non-error for the tool
      if (result.status === 409) {
        return { content: result.error, isError: false };
      }
      return { content: `Error: ${result.error}`, isError: true };
    }

    const lines = [
      'Call ended successfully.',
      `  Call Session ID: ${callSessionId}`,
      `  Status: cancelled`,
    ];
    if (reason) {
      lines.push(`  Reason: ${reason}`);
    }

    return { content: lines.join('\n'), isError: false };
  }
}

registerTool(new CallEndTool());
