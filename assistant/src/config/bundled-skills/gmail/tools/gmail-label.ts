import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import * as gmail from '../client.js';
import { withGmailToken, ok } from './shared.js';

export async function run(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
  const messageId = input.message_id as string;
  const addLabelIds = input.add_label_ids as string[] | undefined;
  const removeLabelIds = input.remove_label_ids as string[] | undefined;

  return withGmailToken(async (token) => {
    await gmail.modifyMessage(token, messageId, { addLabelIds, removeLabelIds });
    return ok('Labels updated.');
  });
}
