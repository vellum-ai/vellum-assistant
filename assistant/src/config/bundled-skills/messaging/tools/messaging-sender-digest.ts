import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok, resolveProvider, withProviderToken } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const platform = input.platform as string | undefined;
  const query = (input.query as string) ?? "category:promotions newer_than:90d";
  const maxMessages = input.max_messages as number | undefined;
  const maxSenders = input.max_senders as number | undefined;
  const pageToken = input.page_token as string | undefined;

  try {
    const provider = resolveProvider(platform);

    if (!provider.senderDigest) {
      return err(
        `The ${provider.displayName} provider does not support sender digest scanning.`,
      );
    }

    return withProviderToken(provider, async (token) => {
      const result = await provider.senderDigest!(token, query, {
        maxMessages,
        maxSenders,
        pageToken,
      });

      if (result.senders.length === 0) {
        return ok(
          JSON.stringify({
            senders: [],
            total_scanned: result.totalScanned,
            query_used: result.queryUsed,
            ...(result.truncated ? { truncated: true } : {}),
            message:
              "No emails found matching the query. Try broadening the search (e.g. remove category filter or extend date range).",
          }),
        );
      }

      // Map to snake_case output format for LLM consumption
      const senders = result.senders.map((s) => ({
        id: s.id,
        display_name: s.displayName,
        email: s.email,
        message_count: s.messageCount,
        has_unsubscribe: s.hasUnsubscribe,
        newest_message_id: s.newestMessageId,
        search_query: s.searchQuery,
      }));

      return ok(
        JSON.stringify({
          senders,
          total_scanned: result.totalScanned,
          query_used: result.queryUsed,
          ...(result.truncated ? { truncated: true } : {}),
          note: `message_count reflects emails found per sender within the ${result.totalScanned} messages scanned. Use messaging_archive_by_sender with the sender's search_query to archive their messages.`,
        }),
      );
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
