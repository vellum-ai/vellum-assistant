import { createDraft } from "../../../../messaging/providers/gmail/client.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok, resolveProvider, withProviderToken } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const platform = input.platform as string | undefined;
  const conversationId = input.conversation_id as string;
  const text = input.text as string;
  const subject = input.subject as string | undefined;
  const inReplyTo = input.in_reply_to as string | undefined;

  if (!conversationId) {
    return err("conversation_id is required.");
  }
  if (!text) {
    return err("text is required.");
  }

  try {
    const provider = resolveProvider(platform);

    // Gmail: create a draft instead of sending directly
    if (provider.id === "gmail") {
      return withProviderToken(provider, async (token) => {
        const draft = await createDraft(
          token,
          conversationId,
          subject ?? "",
          text,
          inReplyTo,
        );
        return ok(
          `Gmail draft created (ID: ${draft.id}). Review it in your Gmail Drafts, then tell me to send it or send it yourself from Gmail.`,
        );
      });
    }

    return withProviderToken(provider, async (token) => {
      const result = await provider.sendMessage(token, conversationId, text, {
        subject,
        inReplyTo,
        assistantId: context.assistantId,
      });

      const threadSuffix = result.threadId
        ? `, "thread_id": "${result.threadId}"`
        : "";
      return ok(`Message sent (ID: ${result.id}${threadSuffix}).`);
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
