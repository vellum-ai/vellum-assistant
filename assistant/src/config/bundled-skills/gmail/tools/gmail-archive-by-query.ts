import {
  batchModifyMessages,
  listMessages,
} from "../../../../messaging/providers/gmail/client.js";
import { getMessagingProvider } from "../../../../messaging/registry.js";
import { withValidToken } from "../../../../security/token-manager.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

const BATCH_MODIFY_LIMIT = 1000;
const MAX_MESSAGES = 5000;

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  if (!context.triggeredBySurfaceAction) {
    return err(
      "This tool requires user confirmation via a surface action. Present results in a selection table with action buttons and wait for the user to click before proceeding.",
    );
  }

  const query = input.query as string;

  if (!query) {
    return err("query is required.");
  }

  try {
    const provider = getMessagingProvider("gmail");
    return withValidToken(provider.credentialService, async (token) => {
      // Paginate through matching messages, capped to prevent unbounded API/memory usage
      const allMessageIds: string[] = [];
      let pageToken: string | undefined;
      let truncated = false;

      while (allMessageIds.length < MAX_MESSAGES) {
        const listResp = await listMessages(
          token,
          query,
          Math.min(500, MAX_MESSAGES - allMessageIds.length),
          pageToken,
        );
        const ids = (listResp.messages ?? []).map((m) => m.id);
        if (ids.length === 0) break;
        allMessageIds.push(...ids);
        pageToken = listResp.nextPageToken ?? undefined;
        if (!pageToken) break;
      }

      // If we stopped because we hit the cap while more pages existed, flag truncation
      if (allMessageIds.length >= MAX_MESSAGES && pageToken) {
        truncated = true;
      }

      if (allMessageIds.length === 0) {
        return ok("No messages matched the query. Nothing archived.");
      }

      // Archive in chunks of BATCH_MODIFY_LIMIT (Gmail's per-call limit)
      for (let i = 0; i < allMessageIds.length; i += BATCH_MODIFY_LIMIT) {
        const chunk = allMessageIds.slice(i, i + BATCH_MODIFY_LIMIT);
        await batchModifyMessages(token, chunk, { removeLabelIds: ["INBOX"] });
      }

      const summary = `Archived ${allMessageIds.length} message(s) matching query: ${query}`;
      if (truncated) {
        return ok(
          `${summary}\n\nNote: this operation was capped at ${MAX_MESSAGES} messages. Additional messages matching the query may remain in the inbox. Run the command again to archive more.`,
        );
      }
      return ok(summary);
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
