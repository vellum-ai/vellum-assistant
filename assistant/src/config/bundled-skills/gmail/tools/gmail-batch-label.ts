import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import * as gmail from '../../../../integrations/gmail/client.js';
import { withGmailToken, ok } from './shared.js';

export async function run(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
  const messageIds = input.message_ids as string[];
  const addLabelIds = input.add_label_ids as string[] | undefined;
  const removeLabelIds = input.remove_label_ids as string[] | undefined;

  return withGmailToken(async (token) => {
    await gmail.batchModifyMessages(token, messageIds, { addLabelIds, removeLabelIds });
    return ok(`Labels updated on ${messageIds.length} message(s).`);
  });
}
