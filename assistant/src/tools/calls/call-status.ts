import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { getCallSession, getActiveCallSessionForConversation, getPendingQuestion } from '../../calls/call-store.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('call-status');

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

    try {
      let session;

      if (callSessionId) {
        session = getCallSession(callSessionId);
        if (!session) {
          return { content: `Error: no call session found with ID ${callSessionId}`, isError: true };
        }
      } else {
        session = getActiveCallSessionForConversation(context.conversationId);
        if (!session) {
          return { content: 'No active call found in the current conversation.', isError: false };
        }
      }

      log.info({ callSessionId: session.id, status: session.status }, 'Checking call status');

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

      // Check for pending questions from the call
      const pendingQuestion = getPendingQuestion(session.id);
      if (pendingQuestion) {
        lines.push('');
        lines.push(`  Pending Question: ${pendingQuestion.questionText}`);
        lines.push(`  Question ID: ${pendingQuestion.id}`);
      }

      return { content: lines.join('\n'), isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, callSessionId }, 'Failed to check call status');
      return { content: `Error checking call status: ${msg}`, isError: true };
    }
  }
}

registerTool(new CallStatusTool());
