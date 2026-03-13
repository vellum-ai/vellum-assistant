import { updateMessage } from "../../../../messaging/providers/slack/client.js";
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
  const timestamp = input.timestamp as string;
  const text = input.text as string;

  if (!channel || !timestamp || !text) {
    return err("channel, timestamp, and text are all required.");
  }

  try {
    const connection = await getSlackConnection();
    await updateMessage(connection, channel, timestamp, text);
    return ok(`Message updated.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
