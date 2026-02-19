import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { getCallSession, updateCallSession } from '../../calls/call-store.js';
import { getCallOrchestrator, unregisterCallOrchestrator } from '../../calls/call-state.js';
import { activeRelayConnections } from '../../calls/relay-server.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('call-end');

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

    try {
      const session = getCallSession(callSessionId);
      if (!session) {
        return { content: `Error: no call session found with ID ${callSessionId}`, isError: true };
      }

      if (session.status === 'completed' || session.status === 'failed') {
        return {
          content: `Call session ${callSessionId} has already ended with status: ${session.status}`,
          isError: false,
        };
      }

      log.info({ callSessionId, reason }, 'Ending call');

      // End the relay connection if active
      const relayConnection = activeRelayConnections.get(callSessionId);
      if (relayConnection) {
        relayConnection.endSession(reason);
        relayConnection.destroy();
        activeRelayConnections.delete(callSessionId);
      }

      // Clean up orchestrator
      const orchestrator = getCallOrchestrator(callSessionId);
      if (orchestrator) {
        orchestrator.destroy();
        unregisterCallOrchestrator(callSessionId);
      }

      // Update session status
      updateCallSession(callSessionId, {
        status: 'completed',
        endedAt: Date.now(),
      });

      log.info({ callSessionId }, 'Call ended successfully');

      const lines = [
        'Call ended successfully.',
        `  Call Session ID: ${callSessionId}`,
        `  Status: completed`,
      ];
      if (reason) {
        lines.push(`  Reason: ${reason}`);
      }

      return { content: lines.join('\n'), isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, callSessionId }, 'Failed to end call');
      return { content: `Error ending call: ${msg}`, isError: true };
    }
  }
}

registerTool(new CallEndTool());
