import { deleteMessage } from "../../../../messaging/providers/slack/client.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok, withSlackToken } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const channel = input.channel as string;
  const timestamp = input.timestamp as string;

  if (!channel || !timestamp) {
    return err("channel and timestamp are both required.");
  }

  try {
    return await withSlackToken(async (token) => {
      await deleteMessage(token, channel, timestamp);
      return ok(`Message deleted.`);
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
