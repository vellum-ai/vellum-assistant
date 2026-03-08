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
  const messageId = input.message_id as string | undefined;

  if (!conversationId) {
    return err("conversation_id is required.");
  }

  try {
    const provider = resolveProvider(platform);
    if (!provider.markRead) {
      return err(
        `${provider.displayName} does not support marking messages as read.`,
      );
    }
    return withProviderToken(provider, async (token) => {
      await provider.markRead!(token, conversationId, messageId);
      return ok("Marked as read.");
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
