import {
  listMessages,
  updateMessageFlag,
} from "../../../../messaging/providers/outlook/client.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  const action = input.action as string;

  if (!action) {
    return err("action is required (track, list, untrack, or complete).");
  }

  try {
    const connection = await resolveOAuthConnection("outlook", {
      account,
    });

    switch (action) {
      case "track": {
        const messageId = input.message_id as string;
        if (!messageId) return err("message_id is required for track action.");

        await updateMessageFlag(connection, messageId, {
          flagStatus: "flagged",
        });
        return ok("Message flagged for follow-up.");
      }

      case "complete": {
        const messageId = input.message_id as string;
        if (!messageId)
          return err("message_id is required for complete action.");

        await updateMessageFlag(connection, messageId, {
          flagStatus: "complete",
        });
        return ok("Follow-up marked complete.");
      }

      case "untrack": {
        const messageId = input.message_id as string;
        if (!messageId)
          return err("message_id is required for untrack action.");

        await updateMessageFlag(connection, messageId, {
          flagStatus: "notFlagged",
        });
        return ok("Follow-up flag removed.");
      }

      case "list": {
        const resp = await listMessages(connection, {
          filter: "flag/flagStatus eq 'flagged'",
          top: 50,
          select:
            "id,conversationId,subject,bodyPreview,body,from,toRecipients,receivedDateTime,isRead,hasAttachments,parentFolderId,categories,flag",
          orderby: "receivedDateTime desc",
        });

        const messages = resp.value ?? [];
        if (messages.length === 0) {
          return ok("No messages are currently flagged for follow-up.");
        }

        const items = messages.map((m) => ({
          id: m.id,
          conversationId: m.conversationId,
          subject: m.subject,
          from: m.from?.emailAddress?.address ?? "",
          date: m.receivedDateTime,
        }));

        return ok(JSON.stringify(items, null, 2));
      }

      default:
        return err(
          `Unknown action "${action}". Use track, list, untrack, or complete.`,
        );
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
