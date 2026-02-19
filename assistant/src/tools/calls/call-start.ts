import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { startCall } from '../../calls/call-domain.js';

const definition: ToolDefinition = {
  name: 'call_start',
  description:
    'Place an outbound phone call via AI voice. The assistant will converse with the callee on behalf of the user.',
  input_schema: {
    type: 'object',
    properties: {
      phone_number: {
        type: 'string',
        description: 'E.164 formatted phone number (e.g. +14155551234)',
      },
      task: {
        type: 'string',
        description: 'What the call should accomplish',
      },
      context: {
        type: 'string',
        description: 'Additional context for the conversation',
      },
    },
    required: ['phone_number', 'task'],
  },
};

class CallStartTool implements Tool {
  name = 'call_start';
  description = definition.description;
  category = 'communication';
  defaultRiskLevel = RiskLevel.High;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const result = await startCall({
      phoneNumber: input.phone_number as string,
      task: input.task as string,
      context: input.context as string | undefined,
      conversationId: context.conversationId,
    });

    if (!result.ok) {
      return { content: `Error: ${result.error}`, isError: true };
    }

    return {
      content: [
        'Call initiated successfully.',
        `  Call Session ID: ${result.session.id}`,
        `  Call SID: ${result.callSid}`,
        `  To: ${result.session.toNumber}`,
        `  Status: initiated`,
        '',
        'The AI voice assistant is now placing the call. Use call_status to check progress.',
      ].join('\n'),
      isError: false,
    };
  }
}

registerTool(new CallStartTool());
