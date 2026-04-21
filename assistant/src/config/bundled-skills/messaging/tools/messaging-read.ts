import type { Message } from "../../../../messaging/provider-types.js";
import { wrapUntrustedContent } from "../../../../security/untrusted-content.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, getProviderConnection, ok, resolveProvider } from "./shared.js";

function wrapMessageContent(msg: Message): Message {
  const source =
    msg.platform === "gmail" || msg.platform === "outlook" ? "email" : "slack";
  return {
    ...msg,
    text: wrapUntrustedContent(msg.text, {
      source,
      sourceDetail: msg.sender.email ?? msg.sender.name,
    }),
  };
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const platform = input.platform as string | undefined;
  const conversationId = input.conversation_id as string;
  const limit = input.limit as number | undefined;
  const threadId = input.thread_id as string | undefined;

  if (!conversationId) {
    return err("conversation_id is required.");
  }

  try {
    const provider = await resolveProvider(platform);
    const account = input.account as string | undefined;
    const conn = await getProviderConnection(provider, account);
    let messages;
    if (threadId && provider.getThreadReplies) {
      messages = await provider.getThreadReplies(
        conn,
        conversationId,
        threadId,
        { limit },
      );
    } else {
      messages = await provider.getHistory(conn, conversationId, { limit });
    }
    return ok(JSON.stringify(messages.map(wrapMessageContent), null, 2));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
