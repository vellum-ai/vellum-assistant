import { addReaction } from "../../../../messaging/providers/slack/client.js";
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
  const emoji = input.emoji as string;

  if (!channel || !timestamp || !emoji) {
    return err("channel, timestamp, and emoji are all required.");
  }

  try {
    return await withSlackToken(async (token) => {
      await addReaction(token, channel, timestamp, emoji);
      return ok(`Added :${emoji}: reaction.`);
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
