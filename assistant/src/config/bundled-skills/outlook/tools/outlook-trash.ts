import { trashMessage } from "../../../../messaging/providers/outlook/client.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  const messageId = input.message_id as string;

  if (!messageId) {
    return err("message_id is required.");
  }

  try {
    const connection = await resolveOAuthConnection("outlook", {
      account,
    });
    await trashMessage(connection, messageId);
    return ok("Message moved to Deleted Items.");
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
