import { startCall } from '../../calls/call-domain.js';
import { getConfig } from '../../config/loader.js';
import type { ToolContext, ToolExecutionResult } from '../types.js';

export async function executeCallStart(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  if (!getConfig().calls.enabled) {
    return { content: 'Error: Calls feature is disabled via configuration. Set calls.enabled to true to use this feature.', isError: true };
  }

  const result = await startCall({
    phoneNumber: input.phone_number as string,
    task: input.task as string,
    context: input.context as string | undefined,
    conversationId: context.conversationId,
    assistantId: context.assistantId,
    callerIdentityMode: input.caller_identity_mode as 'assistant_number' | 'user_number' | undefined,
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
      `  From: ${result.session.fromNumber}`,
      `  Caller Identity Mode: ${result.callerIdentityMode}`,
      `  Status: initiated`,
      '',
      'The AI voice assistant is now placing the call. Use call_status to check progress.',
    ].join('\n'),
    isError: false,
  };
}
