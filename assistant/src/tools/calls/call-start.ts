import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { DENIED_NUMBERS } from '../../calls/call-constants.js';
import { createCallSession, updateCallSession } from '../../calls/call-store.js';
import { TwilioConversationRelayProvider } from '../../calls/twilio-provider.js';
import { getTwilioConfig } from '../../calls/twilio-config.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('call-start');

const E164_REGEX = /^\+\d+$/;

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
    const phoneNumber = input.phone_number as string | undefined;
    if (!phoneNumber || typeof phoneNumber !== 'string') {
      return { content: 'Error: phone_number is required and must be a string', isError: true };
    }

    if (!E164_REGEX.test(phoneNumber)) {
      return {
        content: 'Error: phone_number must be in E.164 format (starts with + followed by digits, e.g. +14155551234)',
        isError: true,
      };
    }

    const task = input.task as string | undefined;
    if (!task || typeof task !== 'string' || task.trim().length === 0) {
      return { content: 'Error: task is required and must be a non-empty string', isError: true };
    }

    if (DENIED_NUMBERS.has(phoneNumber)) {
      return { content: 'Error: this phone number is not allowed to be called', isError: true };
    }

    const callContext = input.context as string | undefined;

    try {
      const config = getTwilioConfig();
      const provider = new TwilioConversationRelayProvider();

      const session = createCallSession({
        conversationId: context.conversationId,
        provider: 'twilio',
        fromNumber: config.phoneNumber,
        toNumber: phoneNumber,
        task: callContext ? `${task}\n\nContext: ${callContext}` : task,
      });

      log.info({ callSessionId: session.id, to: phoneNumber, task }, 'Initiating outbound call');

      const baseUrl = process.env.BASE_URL ?? 'https://localhost:7821';
      const { callSid } = await provider.initiateCall({
        from: config.phoneNumber,
        to: phoneNumber,
        webhookUrl: `${baseUrl}/v1/calls/twilio/voice-webhook?callSessionId=${session.id}`,
        statusCallbackUrl: `${baseUrl}/v1/calls/twilio/status`,
      });

      updateCallSession(session.id, { providerCallSid: callSid });

      log.info({ callSessionId: session.id, callSid }, 'Call initiated successfully');

      return {
        content: [
          'Call initiated successfully.',
          `  Call Session ID: ${session.id}`,
          `  Call SID: ${callSid}`,
          `  To: ${phoneNumber}`,
          `  Status: initiated`,
          '',
          'The AI voice assistant is now placing the call. Use call_status to check progress.',
        ].join('\n'),
        isError: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, phoneNumber }, 'Failed to initiate call');
      return { content: `Error initiating call: ${msg}`, isError: true };
    }
  }
}

registerTool(new CallStartTool());
