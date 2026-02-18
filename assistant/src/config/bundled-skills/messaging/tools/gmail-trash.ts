import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { withValidToken } from '../../../../security/token-manager.js';
import { getMessagingProvider } from '../../../../messaging/registry.js';
import { trashMessage } from '../../../../messaging/providers/gmail/client.js';
import { ok, err } from './shared.js';

export async function run(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
  const messageId = input.message_id as string;

  if (!messageId) {
    return err('message_id is required.');
  }

  try {
    const provider = getMessagingProvider('gmail');
    return withValidToken(provider.credentialService, async (token) => {
      await trashMessage(token, messageId);
      return ok('Message moved to trash.');
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
