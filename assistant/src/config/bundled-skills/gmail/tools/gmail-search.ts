import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import * as gmail from '../client.js';
import type { GmailMessageFormat } from '../types.js';
import { withGmailToken, ok } from './shared.js';

export async function run(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
  const query = input.query as string;
  const maxResults = Math.min((input.max_results as number) ?? 20, 200);
  const format = (input.format as GmailMessageFormat) ?? 'metadata';
  const metadataHeaders = input.metadata_headers as string[] | undefined;

  return withGmailToken(async (token) => {
    const listResult = await gmail.listMessages(token, query, maxResults);
    if (!listResult.messages?.length) {
      return ok('No messages found.');
    }

    if (format === 'minimal') {
      return ok(JSON.stringify(listResult, null, 2));
    }

    const messages = await gmail.batchGetMessages(
      token,
      listResult.messages.map((m) => m.id),
      format,
      metadataHeaders,
    );
    return ok(JSON.stringify({
      resultSizeEstimate: listResult.resultSizeEstimate,
      nextPageToken: listResult.nextPageToken,
      messages,
    }, null, 2));
  });
}
