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
  const addLabelIds = input.add_label_ids as string[] | undefined;
  const removeLabelIds = input.remove_label_ids as string[] | undefined;

  if (!messageId) {
    return err("message_id is required.");
  }

  try {
    const provider = getMessagingProvider("gmail");
    return withValidToken(provider.credentialService, async (token) => {
      await modifyMessage(token, messageId, { addLabelIds, removeLabelIds });
      return ok("Labels updated.");
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
