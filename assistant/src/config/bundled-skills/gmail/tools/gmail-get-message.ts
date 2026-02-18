import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import * as gmail from '../client.js';
import type { GmailMessageFormat } from '../types.js';
import { withGmailToken, ok } from './shared.js';

export async function run(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
  const messageId = input.message_id as string;
  const format = (input.format as GmailMessageFormat) ?? 'full';

  return withGmailToken(async (token) => {
    const message = await gmail.getMessage(token, messageId, format);
    return ok(JSON.stringify(message, null, 2));
  });
}
