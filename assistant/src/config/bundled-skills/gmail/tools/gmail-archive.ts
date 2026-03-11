import {
  batchModifyMessages,
  listMessages,
  modifyMessage,
} from "../../../../messaging/providers/gmail/client.js";
import { getMessagingProvider } from "../../../../messaging/registry.js";
import { withValidToken } from "../../../../security/token-manager.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { getSenderMessageIds } from "./scan-result-store.js";
import { err, ok } from "./shared.js";

const BATCH_MODIFY_LIMIT = 1000;
const MAX_MESSAGES = 5000;

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const query = input.query as string | undefined;
  const scanId = input.scan_id as string | undefined;
  const senderIds = input.sender_ids as string[] | undefined;
  let messageIds = input.message_ids as string[] | undefined;
  const messageId = input.message_id as string | undefined;

  // Resolve message IDs via priority: query → scan_id+sender_ids → message_ids → message_id
  if (query) {
    // Query path requires surface action confirmation
    if (!context.triggeredBySurfaceAction) {
      return err(
        "This tool requires user confirmation via a surface action. Present results in a selection table with action buttons and wait for the user to click before proceeding.",
      );
    }

    try {
      const provider = getMessagingProvider("gmail");
      return withValidToken(provider.credentialService, async (token) => {
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

        if (allMessageIds.length >= MAX_MESSAGES && pageToken) {
          truncated = true;
        }

        if (allMessageIds.length === 0) {
          return ok("No messages matched the query. Nothing archived.");
        }

        for (let i = 0; i < allMessageIds.length; i += BATCH_MODIFY_LIMIT) {
          const chunk = allMessageIds.slice(i, i + BATCH_MODIFY_LIMIT);
          await batchModifyMessages(token, chunk, {
            removeLabelIds: ["INBOX"],
          });
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
  } else if (scanId && senderIds?.length) {
    // Scan path requires surface action confirmation
    if (!context.triggeredBySurfaceAction) {
      return err(
        "This tool requires user confirmation via a surface action. Present results in a selection table with action buttons and wait for the user to click before proceeding.",
      );
    }

    const resolved = getSenderMessageIds(scanId, senderIds);
    if (!resolved) {
      return err(
        "Scan results have expired (30-minute window). Please re-run the scan to get fresh results.",
      );
    }
    messageIds = resolved;
  } else if (messageIds?.length) {
    // Batch message_ids path requires surface action confirmation
    if (!context.triggeredBySurfaceAction) {
      return err(
        "This tool requires user confirmation via a surface action. Present results in a selection table with action buttons and wait for the user to click before proceeding.",
      );
    }
  } else if (messageId) {
    // Single message path
    try {
      const provider = getMessagingProvider("gmail");
      return withValidToken(provider.credentialService, async (token) => {
        await modifyMessage(token, messageId, { removeLabelIds: ["INBOX"] });
        return ok("Message archived.");
      });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  } else {
    return err(
      "Provide message_id, message_ids, scan_id + sender_ids, or query.",
    );
  }

  // Batch path for scan_id+sender_ids and message_ids
  if (!messageIds?.length) {
    return err("Resolved message list is empty — no messages to archive.");
  }

  try {
    const provider = getMessagingProvider("gmail");
    return withValidToken(provider.credentialService, async (token) => {
      if (messageIds.length === 1) {
        await modifyMessage(token, messageIds[0], {
          removeLabelIds: ["INBOX"],
        });
        return ok("Message archived.");
      }

      for (let i = 0; i < messageIds.length; i += BATCH_MODIFY_LIMIT) {
        const chunk = messageIds.slice(i, i + BATCH_MODIFY_LIMIT);
        await batchModifyMessages(token, chunk, {
          removeLabelIds: ["INBOX"],
        });
      }
      return ok(`Archived ${messageIds.length} message(s).`);
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
