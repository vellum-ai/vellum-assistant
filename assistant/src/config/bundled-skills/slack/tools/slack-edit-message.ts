import { updateMessage } from "../../../../messaging/providers/slack/client.js";
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
  const text = input.text as string;

  if (!channel || !timestamp || !text) {
    return err("channel, timestamp, and text are all required.");
  }

  try {
    return await withSlackToken(async (token) => {
      await updateMessage(token, channel, timestamp, text);
      return ok(`Message updated.`);
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
