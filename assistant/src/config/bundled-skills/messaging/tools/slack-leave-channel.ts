import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { withValidToken } from '../../../../security/token-manager.js';
import { getMessagingProvider } from '../../../../messaging/registry.js';
import { leaveConversation } from '../../../../messaging/providers/slack/client.js';
import { ok, err } from './shared.js';

export async function run(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
  const channel = input.channel as string;

  if (!channel) {
    return err('channel is required.');
  }

  try {
    const provider = getMessagingProvider('slack');
    return withValidToken(provider.credentialService, async (token) => {
      await leaveConversation(token, channel);
      return ok('Left channel.');
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
