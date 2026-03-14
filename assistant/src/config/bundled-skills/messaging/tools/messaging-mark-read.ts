import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, getProviderConnection, ok, resolveProvider } from "./shared.js";

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
    const provider = await resolveProvider(platform);
    if (!provider.markRead) {
      return err(
        `${provider.displayName} does not support marking messages as read.`,
      );
    }
    const account = input.account as string | undefined;
    const conn = await getProviderConnection(provider, account);
    await provider.markRead(conn, conversationId, messageId);
    return ok("Marked as read.");
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
