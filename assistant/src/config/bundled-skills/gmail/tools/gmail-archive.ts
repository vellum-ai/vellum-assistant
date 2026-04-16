import {
  batchModifyMessages,
  listMessages,
  modifyMessage,
} from "../../../../messaging/providers/gmail/client.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { addToBlocklist } from "./gmail-preferences.js";
import { getSenderMessageIds } from "./scan-result-store.js";
import { err, ok } from "./shared.js";

const BATCH_MODIFY_LIMIT = 1000;
const MAX_MESSAGES = 5000;

function decodeSenderEmail(senderId: string): string | null {
  try {
    return Buffer.from(senderId, "base64url").toString("utf-8");
  } catch {
    return null;
  }
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  const query = input.query as string | undefined;
  const scanId = input.scan_id as string | undefined;
  const senderIds = input.sender_ids as string[] | undefined;
  let messageIds = input.message_ids as string[] | undefined;
  const messageId = input.message_id as string | undefined;

  // Resolve message IDs via priority: query → scan_id+sender_ids → message_ids → message_id
  if (query) {
    // Query path requires surface action confirmation
    if (!context.triggeredBySurfaceAction && !context.batchAuthorizedByTask) {
      return err(
        "This tool requires either a surface action or a scheduled task run with this tool in required_tools. Present results in a selection table with action buttons and wait for the user to click before proceeding.",
      );
    }

    try {
      const connection = await resolveOAuthConnection("google", {
        account,
      });
      const allMessageIds: string[] = [];
      let pageToken: string | undefined;
      let truncated = false;

      while (allMessageIds.length < MAX_MESSAGES) {
        const listResp = await listMessages(
          connection,
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
        await batchModifyMessages(connection, chunk, {
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
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  } else if (scanId && senderIds?.length) {
    // Scan path requires surface action confirmation
    if (!context.triggeredBySurfaceAction && !context.batchAuthorizedByTask) {
      return err(
        "This tool requires either a surface action or a scheduled task run with this tool in required_tools. Present results in a selection table with action buttons and wait for the user to click before proceeding.",
      );
    }

    const resolved = getSenderMessageIds(scanId, senderIds);
    if (resolved !== null && resolved.length > 0) {
      messageIds = resolved;
    } else if (resolved === null) {
      // Scan expired or sender IDs unresolved — fall back to query-based archiving
      const emails: string[] = [];
      const undecodable: string[] = [];
      for (const sid of senderIds) {
        const email = decodeSenderEmail(sid);
        if (email && email.includes("@")) {
          emails.push(email);
        } else {
          undecodable.push(sid);
        }
      }

      if (emails.length === 0) {
        return err(
          "Scan results have expired and sender IDs could not be decoded. Please re-run the scan.",
        );
      }

      try {
        const connection = await resolveOAuthConnection("google", {
          account,
        });
        const allMessageIds: string[] = [];

        for (const email of emails) {
          const fallbackQuery = `from:"${email.replace(/"/g, "")}" in:inbox`;
          let pageToken: string | undefined;
          while (allMessageIds.length < MAX_MESSAGES) {
            const listResp = await listMessages(
              connection,
              fallbackQuery,
              Math.min(500, MAX_MESSAGES - allMessageIds.length),
              pageToken,
            );
            const ids = (listResp.messages ?? []).map((m) => m.id);
            if (ids.length === 0) break;
            allMessageIds.push(...ids);
            pageToken = listResp.nextPageToken ?? undefined;
            if (!pageToken) break;
          }
          if (allMessageIds.length >= MAX_MESSAGES) break;
        }

        if (allMessageIds.length === 0) {
          return ok("No inbox messages found for the selected senders.");
        }

        for (let i = 0; i < allMessageIds.length; i += BATCH_MODIFY_LIMIT) {
          const chunk = allMessageIds.slice(i, i + BATCH_MODIFY_LIMIT);
          await batchModifyMessages(connection, chunk, {
            removeLabelIds: ["INBOX"],
          });
        }

        const parts = [
          `Archived ${allMessageIds.length} message(s) via query fallback (scan results had expired).`,
        ];
        if (undecodable.length > 0) {
          parts.push(
            `${undecodable.length} sender ID(s) could not be decoded and were skipped.`,
          );
        }
        return ok(parts.join(" "));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    } else {
      return err(
        "The provided sender IDs do not match the scan results. Please re-run the scan.",
      );
    }
  } else if (messageIds?.length) {
    // Batch message_ids path requires surface action confirmation
    if (!context.triggeredBySurfaceAction && !context.batchAuthorizedByTask) {
      return err(
        "This tool requires either a surface action or a scheduled task run with this tool in required_tools. Present results in a selection table with action buttons and wait for the user to click before proceeding.",
      );
    }
  } else if (messageId) {
    // Single message path
    try {
      const connection = await resolveOAuthConnection("google", {
        account,
      });
      await modifyMessage(connection, messageId, { removeLabelIds: ["INBOX"] });
      return ok("Message archived.");
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
    return err("Resolved message list is empty - no messages to archive.");
  }

  try {
    const connection = await resolveOAuthConnection("google", {
      account,
    });
    if (messageIds.length === 1) {
      await modifyMessage(connection, messageIds[0], {
        removeLabelIds: ["INBOX"],
      });
      return ok("Message archived.");
    }

    for (let i = 0; i < messageIds.length; i += BATCH_MODIFY_LIMIT) {
      const chunk = messageIds.slice(i, i + BATCH_MODIFY_LIMIT);
      await batchModifyMessages(connection, chunk, {
        removeLabelIds: ["INBOX"],
      });
    }
    // Record archived sender emails for future sessions (only after success)
    if (senderIds?.length) {
      const archivedEmails: string[] = [];
      for (const sid of senderIds) {
        try {
          const email = Buffer.from(sid, "base64url").toString("utf-8");
          if (email.includes("@")) archivedEmails.push(email);
        } catch {
          // Skip undecodable sender IDs
        }
      }
      if (archivedEmails.length > 0) {
        try {
          addToBlocklist(archivedEmails);
        } catch {
          // Non-fatal — preferences are best-effort
        }
      }
    }
    return ok(`Archived ${messageIds.length} message(s).`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
