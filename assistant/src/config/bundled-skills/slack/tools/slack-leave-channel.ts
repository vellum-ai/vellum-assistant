import { leaveConversation } from "../../../../messaging/providers/slack/client.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, getSlackConnection, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const channel = input.channel as string;

  if (!channel) {
    return err("channel is required.");
  }

  try {
    const connection = getSlackConnection();
    await leaveConversation(connection, channel);
    return ok("Left channel.");
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
