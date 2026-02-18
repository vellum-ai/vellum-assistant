import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import * as gmail from '../client.js';
import { withGmailToken, ok } from './shared.js';

export async function run(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
  const maxResults = Math.min((input.max_results as number) ?? 20, 200);
  const labelIds = input.label_ids as string[] | undefined;
  const pageToken = input.page_token as string | undefined;

  return withGmailToken(async (token) => {
    const result = await gmail.listMessages(token, undefined, maxResults, pageToken, labelIds);
    return ok(JSON.stringify(result, null, 2));
  });
}
