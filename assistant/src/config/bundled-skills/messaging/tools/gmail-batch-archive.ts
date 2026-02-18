import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { withValidToken } from '../../../../security/token-manager.js';
import { getMessagingProvider } from '../../../../messaging/registry.js';
import { batchModifyMessages } from '../../../../messaging/providers/gmail/client.js';
import { ok, err } from './shared.js';

export async function run(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
  const messageIds = input.message_ids as string[];

  if (!messageIds?.length) {
    return err('message_ids is required and must not be empty.');
  }

  try {
    const provider = getMessagingProvider('gmail');
    return withValidToken(provider.credentialService, async (token) => {
      await batchModifyMessages(token, messageIds, { removeLabelIds: ['INBOX'] });
      return ok(`Archived ${messageIds.length} message(s).`);
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
