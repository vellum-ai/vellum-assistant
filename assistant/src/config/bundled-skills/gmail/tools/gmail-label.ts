import {
  batchModifyMessages,
  modifyMessage,
} from "../../../../messaging/providers/gmail/client.js";
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
  const messageId = input.message_id as string | undefined;
  const messageIds = input.message_ids as string[] | undefined;
  const addLabelIds = input.add_label_ids as string[] | undefined;
  const removeLabelIds = input.remove_label_ids as string[] | undefined;

  if (messageIds && messageIds.length > 0) {
    try {
      const provider = getMessagingProvider("gmail");
      return await withValidToken(provider.credentialService, async (token) => {
        await batchModifyMessages(token, messageIds, {
          addLabelIds,
          removeLabelIds,
        });
        return ok(`Labels updated on ${messageIds.length} message(s).`);
      });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  if (messageId) {
    try {
      const provider = getMessagingProvider("gmail");
      return await withValidToken(provider.credentialService, async (token) => {
        await modifyMessage(token, messageId, { addLabelIds, removeLabelIds });
        return ok("Labels updated.");
      });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  return err("Provide message_id or message_ids.");
}
