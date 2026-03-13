import {
  batchGetMessages,
  createLabel,
  listLabels,
  listMessages,
  modifyMessage,
} from "../../../../messaging/providers/gmail/client.js";
import type { OAuthConnection } from "../../../../oauth/connection.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

const FOLLOW_UP_LABEL_NAME = "Follow-up";

async function getOrCreateFollowUpLabel(
  connection: OAuthConnection,
): Promise<string> {
  const labels = await listLabels(connection);
  const existing = labels.find((l) => l.name === FOLLOW_UP_LABEL_NAME);
  if (existing) return existing.id;

  const created = await createLabel(connection, FOLLOW_UP_LABEL_NAME);
  return created.id;
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  const action = input.action as string;

  if (!action) {
    return err("action is required (track, list, or untrack).");
  }

  try {
    const connection = resolveOAuthConnection("integration:gmail", account);
    switch (action) {
      case "track": {
        const messageId = input.message_id as string;
        if (!messageId) return err("message_id is required for track action.");

        const labelId = await getOrCreateFollowUpLabel(connection);
        await modifyMessage(connection, messageId, { addLabelIds: [labelId] });
        return ok("Message marked for follow-up.");
      }

      case "list": {
        const labelId = await getOrCreateFollowUpLabel(connection);
        const listResp = await listMessages(
          connection,
          undefined,
          50,
          undefined,
          [labelId],
        );
        const messageIds = (listResp.messages ?? []).map((m) => m.id);

        if (messageIds.length === 0) {
          return ok("No messages are currently tracked for follow-up.");
        }

        const messages = await batchGetMessages(
          connection,
          messageIds,
          "metadata",
          ["From", "Subject", "Date"],
        );
        const items = messages.map((m) => {
          const headers = m.payload?.headers ?? [];
          const from =
            headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
          const subject =
            headers.find((h) => h.name.toLowerCase() === "subject")?.value ??
            "";
          const date =
            headers.find((h) => h.name.toLowerCase() === "date")?.value ?? "";
          return { id: m.id, threadId: m.threadId, from, subject, date };
        });

        return ok(JSON.stringify(items, null, 2));
      }

      case "untrack": {
        const messageId = input.message_id as string;
        if (!messageId)
          return err("message_id is required for untrack action.");

        const labelId = await getOrCreateFollowUpLabel(connection);
        await modifyMessage(connection, messageId, {
          removeLabelIds: [labelId],
        });
        return ok("Follow-up tracking removed from message.");
      }

      default:
        return err(`Unknown action "${action}". Use track, list, or untrack.`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
