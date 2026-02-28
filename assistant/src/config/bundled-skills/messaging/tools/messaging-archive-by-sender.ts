import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { err, ok, resolveProvider, withProviderToken } from './shared.js';

export async function run(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
  const platform = input.platform as string | undefined;
  const query = input.query as string;

  if (!query) {
    return err('query is required.');
  }

  try {
    const provider = resolveProvider(platform);

    if (!provider.archiveByQuery) {
      return err(`The ${provider.displayName} provider does not support archive by query.`);
    }

    return withProviderToken(provider, async (token) => {
      const result = await provider.archiveByQuery!(token, query);

      if (result.archived === 0) {
        return ok('No messages matched the query. Nothing archived.');
      }

      const summary = `Archived ${result.archived} message(s) matching query: ${query}`;
      if (result.truncated) {
        return ok(`${summary}\n\nNote: this operation was capped at 5000 messages. Additional messages matching the query may remain in the inbox. Run the command again to archive more.`);
      }
      return ok(summary);
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
