import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import * as gmail from '../../../../integrations/gmail/client.js';
import { withGmailToken, ok } from './shared.js';

export async function run(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
  const to = input.to as string;
  const subject = input.subject as string;
  const body = input.body as string;
  const inReplyTo = input.in_reply_to as string | undefined;

  return withGmailToken(async (token) => {
    const message = await gmail.sendMessage(token, to, subject, body, inReplyTo);
    return ok(`Email sent (ID: ${message.id}).`);
  });
}
