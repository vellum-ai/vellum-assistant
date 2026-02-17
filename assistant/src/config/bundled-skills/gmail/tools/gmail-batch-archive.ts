import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import * as gmail from '../../../../integrations/gmail/client.js';
import { withGmailToken, ok } from './shared.js';

export async function run(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
  const messageIds = input.message_ids as string[];

  return withGmailToken(async (token) => {
    await gmail.batchModifyMessages(token, messageIds, { removeLabelIds: ['INBOX'] });
    return ok(`Archived ${messageIds.length} message(s).`);
  });
}
