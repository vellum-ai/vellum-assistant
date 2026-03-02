import { batchModifyMessages } from '../../../../messaging/providers/gmail/client.js';
import { getMessagingProvider } from '../../../../messaging/registry.js';
import { withValidToken } from '../../../../security/token-manager.js';
import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { err,ok } from './shared.js';

const BATCH_MODIFY_LIMIT = 1000;

export async function run(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
  if (!context.triggeredBySurfaceAction) {
    return err('This tool requires user confirmation via a surface action. Present results in a selection table with action buttons and wait for the user to click before proceeding.');
  }

  const messageIds = input.message_ids as string[];

  if (!messageIds?.length) {
    return err('message_ids is required and must not be empty.');
  }

  try {
    const provider = getMessagingProvider('gmail');
    return withValidToken(provider.credentialService, async (token) => {
      for (let i = 0; i < messageIds.length; i += BATCH_MODIFY_LIMIT) {
        const chunk = messageIds.slice(i, i + BATCH_MODIFY_LIMIT);
        await batchModifyMessages(token, chunk, { removeLabelIds: ['INBOX'] });
      }
      return ok(`Archived ${messageIds.length} message(s).`);
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
