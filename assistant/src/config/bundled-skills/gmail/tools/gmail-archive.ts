import { modifyMessage } from "../../../../messaging/providers/gmail/client.js";
import { getMessagingProvider } from "../../../../messaging/registry.js";
import { withValidToken } from "../../../../security/token-manager.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const messageId = input.message_id as string;

  if (!messageId) {
    return err("message_id is required.");
  }

  try {
    const provider = getMessagingProvider("gmail");
    return withValidToken(provider.credentialService, async (token) => {
      await modifyMessage(token, messageId, { removeLabelIds: ["INBOX"] });
      return ok("Message archived.");
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
