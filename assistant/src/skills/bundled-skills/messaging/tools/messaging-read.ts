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
  const conversationId = input.conversation_id as string;
  const limit = input.limit as number | undefined;
  const threadId = input.thread_id as string | undefined;

  if (!conversationId) {
    return err("conversation_id is required.");
  }

  try {
    const provider = resolveProvider(platform);
    return withProviderToken(provider, async (token) => {
      let messages;
      if (threadId && provider.getThreadReplies) {
        messages = await provider.getThreadReplies(
          token,
          conversationId,
          threadId,
          { limit },
        );
      } else {
        messages = await provider.getHistory(token, conversationId, { limit });
      }
      return ok(JSON.stringify(messages, null, 2));
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
