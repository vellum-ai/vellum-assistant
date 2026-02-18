import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { withValidToken } from '../../../../security/token-manager.js';
import { getMessagingProvider } from '../../../../messaging/registry.js';
import { addReaction } from '../../../../messaging/providers/slack/client.js';
import { ok, err } from './shared.js';

export async function run(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
  const channel = input.channel as string;
  const timestamp = input.timestamp as string;
  const emoji = input.emoji as string;

  if (!channel || !timestamp || !emoji) {
    return err('channel, timestamp, and emoji are all required.');
  }

  try {
    const provider = getMessagingProvider('slack');
    return withValidToken(provider.credentialService, async (token) => {
      await addReaction(token, channel, timestamp, emoji);
      return ok(`Added :${emoji}: reaction.`);
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
