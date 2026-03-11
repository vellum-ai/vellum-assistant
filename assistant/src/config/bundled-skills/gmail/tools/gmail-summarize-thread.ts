import {
  batchGetMessages,
  listMessages,
} from "../../../../messaging/providers/gmail/client.js";
import type {
  GmailMessage,
  GmailMessagePart,
} from "../../../../messaging/providers/gmail/types.js";
import { getMessagingProvider } from "../../../../messaging/registry.js";
import { summarizeThread } from "../../../../messaging/thread-summarizer.js";
import type { ThreadMessage } from "../../../../messaging/types.js";
import { withValidToken } from "../../../../security/token-manager.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

function extractHeader(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string,
): string {
  return (
    headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ??
    ""
  );
}

function extractPlainTextBody(part: GmailMessagePart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(
      part.body.data.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf-8");
  }
  if (part.parts) {
    for (const child of part.parts) {
      const text = extractPlainTextBody(child);
      if (text) return text;
    }
  }
  return "";
}

function gmailToThreadMessage(msg: GmailMessage): ThreadMessage {
  const from = extractHeader(msg.payload?.headers, "From");
  const senderName = from.replace(/<[^>]+>/, "").trim() || from;
  return {
    id: msg.id,
    sender: senderName,
    body: extractPlainTextBody(msg.payload),
    timestamp: Number(msg.internalDate ?? 0),
    channel: "email",
  };
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const threadId = input.thread_id as string;

  if (!threadId) {
    return err("thread_id is required.");
  }

  try {
    const provider = getMessagingProvider("gmail");
    return withValidToken(provider.credentialService, async (token) => {
      const listResp = await listMessages(token, `thread:${threadId}`, 50);
      const messageIds = (listResp.messages ?? []).map((m) => m.id);

      if (messageIds.length === 0) {
        return err("No messages found in this thread.");
      }

      const messages = await batchGetMessages(token, messageIds, "full");
      const threadMessages = messages.map(gmailToThreadMessage);
      const summary = await summarizeThread(threadMessages);

      return ok(JSON.stringify(summary, null, 2));
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
